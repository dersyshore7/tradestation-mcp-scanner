import { randomUUID } from "node:crypto";
import { runScan, type ScanResult } from "../app/runScan.js";
import type { ScanConfidence, ScanDirection } from "../scanner/scoring.js";
import {
  TradeCardBlockedAfterConfirmationError,
  constructTradeCard,
  type TradeConstructionResult,
} from "../app/runTradeConstruction.js";
import { createOpenAiClient } from "../openai/client.js";
import { closeJournalTrade, createJournalTrade, listJournalTradeDetails } from "../journal/repository.js";
import type { JournalTradeDetail, JournalExitReason } from "../journal/types.js";
import { readPaperTraderApiSecrets, readPaperTraderConfig } from "./config.js";
import {
  getVirtualPaperAutomationBot,
  type VirtualPaperAutomationKey,
} from "./paperAutomationBots.js";
import {
  loadFmpCongressionalTradeSignals,
  loadFmpStockNews,
  type FmpStockNewsItem,
} from "./fmpSources.js";
import { recordPaperEntryCandidate, listRecentPaperEntryCandidates } from "./entryCandidateHistory.js";
import { listRecentPaperTraderRuns, recordPaperTraderRun } from "./paperTraderHistory.js";
import { createAutomationTradeStationClient, type TradeStationQuoteSnapshot } from "./tradestation.js";

const VIRTUAL_ENTRY_CONFIDENCE: ScanConfidence = "75-84";
const VIRTUAL_POSITION_PCT = 0.3;
const VIRTUAL_TRADE_HISTORY_LIMIT = 1000;
const VIRTUAL_LEAPS_DTE_MIN = 180;
const VIRTUAL_LEAPS_DTE_MAX = 730;
const VIRTUAL_LEAPS_DTE_CENTER = 365;

type VirtualTradeSignal = {
  symbol: string;
  direction: ScanDirection;
  confidence: ScanConfidence;
  reason: string;
  sourceType: string;
  sourceRaw: Record<string, unknown> | null;
  scan: ScanResult | null;
};

type VirtualLedger = {
  startingBalanceUsd: number;
  realizedPlUsd: number;
  openPositionCostUsd: number;
  currentBalanceUsd: number;
  buyingPowerUsd: number;
};

type VirtualManagementResult = {
  inspected: number;
  updates: {
    tradeId: string;
    symbol: string;
    action: string;
    stopUnderlying: number | null;
    targetUnderlying: number | null;
    note: string;
  }[];
  exitsTriggered: {
    tradeId: string;
    symbol: string;
    reason: JournalExitReason;
    action: string;
    note: string;
  }[];
  skipped: {
    tradeId: string;
    symbol: string;
    reason: string;
  }[];
};

type VirtualRunOptions = {
  automationKey: VirtualPaperAutomationKey;
  dryRun?: boolean;
  skipNewEntry?: boolean;
  includeHistory?: boolean;
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function buildEmptyReconciliation() {
  return {
    inspected: 0,
    updated: 0,
    partialFills: 0,
    staleArchived: 0,
    adoptedPositions: 0,
    updates: [],
    skipped: [],
  };
}

function buildEmptyClosedExitReconciliation() {
  return {
    inspected: 0,
    repaired: 0,
    skipped: 0,
    brokerConfirmedRealizedPlUsd: 0,
    journalRealizedPlUsdBefore: 0,
    journalRealizedPlUsdAfter: 0,
    realizedPlDeltaUsd: 0,
    updates: [],
    skippedDetails: [],
    warnings: [],
  };
}

function buildEmptyEntryOrderManagement() {
  return {
    enabled: false,
    inspected: 0,
    updated: 0,
    replaced: 0,
    canceled: 0,
    recommended: 0,
    updates: [],
    skipped: [],
  };
}

function buildEmptyLiveDailyAudit() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    date: today,
    journalRealizedPlUsd: 0,
    brokerConfirmedRealizedPlUsd: null,
    openUnrealizedPlUsd: null,
    biggestLosers: [],
    winnersExitedBeforeTarget: [],
    openPositions: [],
    dataWarnings: [],
  };
}

function buildVirtualLedger(trades: JournalTradeDetail[], startingBalanceUsd: number): VirtualLedger {
  const realizedPlUsd = trades.reduce(
    (sum, trade) => sum + (trade.status === "closed" ? (asNumber(trade.review?.realized_pl_usd) ?? 0) : 0),
    0,
  );
  const openPositionCostUsd = trades.reduce(
    (sum, trade) => sum + (trade.status === "open" ? (asNumber(trade.position_cost_usd) ?? 0) : 0),
    0,
  );
  const currentBalanceUsd = startingBalanceUsd + realizedPlUsd;
  return {
    startingBalanceUsd,
    realizedPlUsd,
    openPositionCostUsd,
    currentBalanceUsd,
    buyingPowerUsd: Math.max(0, currentBalanceUsd - openPositionCostUsd),
  };
}

function readVirtualSnapshot(trade: JournalTradeDetail): Record<string, unknown> | null {
  const snapshot = asRecord(trade.signal_snapshot_json);
  const automation = asRecord(snapshot?.automation);
  return asRecord(automation?.virtualPaperBot);
}

function quoteMark(quote: TradeStationQuoteSnapshot): number | null {
  return quote.mid ?? quote.last ?? quote.bid ?? quote.ask;
}

function readTradeDirection(trade: JournalTradeDetail, snapshot: Record<string, unknown> | null): ScanDirection {
  const direction = typeof snapshot?.direction === "string" ? snapshot.direction : null;
  if (direction === "bullish" || direction === "bearish") {
    return direction;
  }
  return trade.direction === "CALL" ? "bullish" : "bearish";
}

function shouldCloseVirtualTrade(params: {
  trade: JournalTradeDetail;
  snapshot: Record<string, unknown> | null;
  underlyingMark: number | null;
  optionMark: number | null;
  nowDate: string;
}): { reason: JournalExitReason; note: string } | null {
  const direction = readTradeDirection(params.trade, params.snapshot);
  const stop = asNumber(params.snapshot?.intendedStopUnderlying) ?? asNumber(params.trade.intended_stop_underlying);
  const target = asNumber(params.snapshot?.intendedTargetUnderlying) ?? asNumber(params.trade.intended_target_underlying);
  const entryOptionPrice = asNumber(params.snapshot?.entryOptionPrice) ?? asNumber(params.trade.option_entry_price);
  const timeExitDate = typeof params.snapshot?.timeExitDate === "string" ? params.snapshot.timeExitDate : null;

  if (params.underlyingMark !== null && stop !== null) {
    const stopHit = direction === "bullish"
      ? params.underlyingMark <= stop
      : params.underlyingMark >= stop;
    if (stopHit) {
      return {
        reason: "stop_hit",
        note: `Virtual stop hit from read-only quote. Underlying ${params.underlyingMark.toFixed(2)} vs stop ${stop.toFixed(2)}.`,
      };
    }
  }

  if (params.underlyingMark !== null && target !== null) {
    const targetHit = direction === "bullish"
      ? params.underlyingMark >= target
      : params.underlyingMark <= target;
    if (targetHit) {
      return {
        reason: "target_hit",
        note: `Virtual target hit from read-only quote. Underlying ${params.underlyingMark.toFixed(2)} vs target ${target.toFixed(2)}.`,
      };
    }
  }

  if (timeExitDate && params.nowDate >= timeExitDate) {
    return {
      reason: "time_exit",
      note: `Virtual time exit reached ${timeExitDate}.`,
    };
  }

  if (
    entryOptionPrice !== null
    && entryOptionPrice > 0
    && params.optionMark !== null
    && params.optionMark <= entryOptionPrice * 0.75
  ) {
    return {
      reason: "manual_early_exit",
      note: `Virtual premium-decay exit from read-only quote. Option ${params.optionMark.toFixed(2)} is at least 25% below entry ${entryOptionPrice.toFixed(2)}.`,
    };
  }

  return null;
}

async function manageOpenVirtualTrades(
  automationKey: VirtualPaperAutomationKey,
  openTrades: JournalTradeDetail[],
): Promise<VirtualManagementResult> {
  const config = readPaperTraderConfig("paper");
  const client = await createAutomationTradeStationClient(config.automationBaseUrl);
  const now = new Date();
  const nowDate = now.toISOString().slice(0, 10);
  const result: VirtualManagementResult = {
    inspected: 0,
    updates: [],
    exitsTriggered: [],
    skipped: [],
  };

  for (const trade of openTrades) {
    result.inspected += 1;
    const snapshot = readVirtualSnapshot(trade);
    const optionSymbol = typeof snapshot?.optionSymbol === "string" ? snapshot.optionSymbol : null;
    if (!optionSymbol) {
      result.skipped.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: "Open virtual trade is missing optionSymbol metadata.",
      });
      continue;
    }

    try {
      const [underlyingQuote, optionQuote] = await Promise.all([
        client.fetchQuote(trade.symbol),
        client.fetchQuote(optionSymbol),
      ]);
      const underlyingMark = quoteMark(underlyingQuote);
      const optionMark = quoteMark(optionQuote);
      if (optionMark === null || optionMark <= 0) {
        result.skipped.push({
          tradeId: trade.id,
          symbol: trade.symbol,
          reason: "Virtual management could not read a usable option mark.",
        });
        continue;
      }

      const closeDecision = shouldCloseVirtualTrade({
        trade,
        snapshot,
        underlyingMark,
        optionMark,
        nowDate,
      });
      if (!closeDecision) {
        result.updates.push({
          tradeId: trade.id,
          symbol: trade.symbol,
          action: "hold",
          stopUnderlying: asNumber(snapshot?.intendedStopUnderlying) ?? asNumber(trade.intended_stop_underlying),
          targetUnderlying: asNumber(snapshot?.intendedTargetUnderlying) ?? asNumber(trade.intended_target_underlying),
          note: `Virtual hold. Underlying mark ${underlyingMark === null ? "n/a" : underlyingMark.toFixed(2)}, option mark ${optionMark.toFixed(2)}.`,
        });
        continue;
      }

      await closeJournalTrade(trade.id, {
        option_exit_price: optionMark,
        exit_reason: closeDecision.reason,
        exit_timestamp: now.toISOString(),
        quantity_closed: trade.contracts,
        exit_notes: `${closeDecision.note} Paper automation ${automationKey}; no broker order was placed.`,
        exit_price_source: "provisional_quote",
        broker_confirmed: false,
        broker_order_id: null,
        review_notes: closeDecision.note,
      });
      result.exitsTriggered.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: closeDecision.reason,
        action: "virtual_close",
        note: closeDecision.note,
      });
    } catch (error) {
      result.skipped.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

function openSymbols(trades: JournalTradeDetail[]): string[] {
  return trades
    .filter((trade) => trade.status === "open")
    .map((trade) => trade.symbol.toUpperCase());
}

function tradeSignalFromScan(scan: ScanResult, sourceType: string): VirtualTradeSignal | null {
  if (scan.conclusion !== "confirmed" || !scan.ticker || !scan.direction || !scan.confidence) {
    return null;
  }
  if (scan.confidence === "65-74") {
    return null;
  }
  return {
    symbol: scan.ticker,
    direction: scan.direction,
    confidence: scan.confidence,
    reason: scan.reason,
    sourceType,
    sourceRaw: scan.telemetry ? { telemetry: scan.telemetry } : null,
    scan,
  };
}

async function choosePoliticianSignal(excludedSymbols: string[]): Promise<{ signal: VirtualTradeSignal | null; warning: string | null }> {
  const source = await loadFmpCongressionalTradeSignals(100);
  const excluded = new Set(excludedSymbols.map((symbol) => symbol.toUpperCase()));
  const selected = source.items.find((item) => !excluded.has(item.symbol));
  if (!selected) {
    return {
      signal: null,
      warning: source.warning ?? "No usable congressional disclosure signal was available.",
    };
  }

  return {
    signal: {
      symbol: selected.symbol,
      direction: selected.action === "buy" ? "bullish" : "bearish",
      confidence: VIRTUAL_ENTRY_CONFIDENCE,
      reason: `${selected.chamber} disclosure ${selected.action} for ${selected.symbol}${selected.politician ? ` by ${selected.politician}` : ""}.`,
      sourceType: "fmp_congressional_disclosure",
      sourceRaw: selected.raw,
      scan: null,
    },
    warning: source.warning,
  };
}

function firstNewsTicker(news: FmpStockNewsItem[], excludedSymbols: Set<string>): string | null {
  for (const item of news) {
    const symbol = item.tickers.find((ticker) => !excludedSymbols.has(ticker));
    if (symbol) {
      return symbol;
    }
  }
  return null;
}

async function chooseNewsSignalWithOpenAi(
  news: FmpStockNewsItem[],
  excludedSymbols: Set<string>,
): Promise<VirtualTradeSignal | null> {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  const allowedSymbols = [...new Set(news.flatMap((item) => item.tickers))]
    .filter((symbol) => !excludedSymbols.has(symbol))
    .slice(0, 30);
  if (allowedSymbols.length === 0) {
    return null;
  }

  const client = await createOpenAiClient() as unknown as {
    chat: {
      completions: {
        create: (input: {
          model: string;
          response_format: { type: "json_object" };
          messages: { role: "system" | "user"; content: string }[];
        }) => Promise<{ choices: { message?: { content?: string | null } }[] }>;
      };
    };
  };
  const response = await client.chat.completions.create({
    model: process.env.NEWS_REASONING_OPENAI_MODEL ?? "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Choose one options trade candidate from recent stock news. Return JSON only with symbol, direction bullish or bearish, confidence one of 75-84/85-92/93-97, and reason.",
      },
      {
        role: "user",
        content: JSON.stringify({
          allowedSymbols,
          news: news.slice(0, 12).map((item) => ({
            title: item.title,
            tickers: item.tickers,
            site: item.site,
            publishedAt: item.publishedAt,
            text: item.text?.slice(0, 700) ?? null,
          })),
        }),
      },
    ],
  });
  const text = response.choices[0]?.message?.content ?? "{}";
  const parsed = asRecord(JSON.parse(text));
  const symbol = typeof parsed?.symbol === "string" ? parsed.symbol.toUpperCase() : null;
  const direction = parsed?.direction === "bullish" || parsed?.direction === "bearish"
    ? parsed.direction
    : null;
  const confidence = typeof parsed?.confidence === "string" && ["75-84", "85-92", "93-97"].includes(parsed.confidence)
    ? parsed.confidence as ScanConfidence
    : VIRTUAL_ENTRY_CONFIDENCE;
  if (!symbol || !direction || !allowedSymbols.includes(symbol)) {
    return null;
  }

  return {
    symbol,
    direction,
    confidence,
    reason: typeof parsed?.reason === "string" ? parsed.reason : "AI selected the strongest recent news-backed candidate.",
    sourceType: "fmp_news_openai_reasoning",
    sourceRaw: { selectedByOpenAi: parsed },
    scan: null,
  };
}

async function chooseNewsSignal(excludedSymbols: string[]): Promise<{ signal: VirtualTradeSignal | null; warning: string | null }> {
  const source = await loadFmpStockNews(25);
  const excluded = new Set(excludedSymbols.map((symbol) => symbol.toUpperCase()));
  if (source.items.length === 0) {
    return {
      signal: null,
      warning: source.warning ?? "No usable stock news signal was available.",
    };
  }

  try {
    const aiSignal = await chooseNewsSignalWithOpenAi(source.items, excluded);
    if (aiSignal) {
      return { signal: aiSignal, warning: source.warning };
    }
  } catch (error) {
    return {
      signal: null,
      warning: `News AI selection unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const symbol = firstNewsTicker(source.items, excluded);
  return {
    signal: symbol
      ? {
          symbol,
          direction: "bullish",
          confidence: VIRTUAL_ENTRY_CONFIDENCE,
          reason: `Recent FMP stock news mentioned ${symbol}; OpenAI selection was unavailable, so the bot used the first non-open news ticker.`,
          sourceType: "fmp_news_fallback",
          sourceRaw: source.items.find((item) => item.tickers.includes(symbol))?.raw ?? null,
          scan: null,
        }
      : null,
    warning: source.warning,
  };
}

async function chooseScannerSignal(params: {
  automationKey: VirtualPaperAutomationKey;
  prompt: string;
  excludedSymbols: string[];
  tradestationBaseUrlOverride: string;
}): Promise<{ signal: VirtualTradeSignal | null; warning: string | null }> {
  const scan = await runScan({
    prompt: params.prompt,
    excludedTickers: params.excludedSymbols,
    tradestationBaseUrlOverride: params.tradestationBaseUrlOverride,
  });
  return {
    signal: tradeSignalFromScan(scan, params.automationKey),
    warning: scan.conclusion === "confirmed" ? null : scan.reason,
  };
}

async function chooseVirtualTradeSignal(params: {
  automationKey: VirtualPaperAutomationKey;
  excludedSymbols: string[];
  tradestationBaseUrlOverride: string;
}): Promise<{ signal: VirtualTradeSignal | null; warning: string | null }> {
  switch (params.automationKey) {
    case "politician_replica":
      return await choosePoliticianSignal(params.excludedSymbols);
    case "news_reasoning_ai":
      return await chooseNewsSignal(params.excludedSymbols);
    case "leaps_investor_ai":
      return await chooseScannerSignal({
        ...params,
        prompt: "Run a new Scan for this week, favoring durable multi-month trends suitable for a long LEAPS call or put.",
      });
    case "support_resistance_ai":
      return await chooseScannerSignal({
        ...params,
        prompt: "Run a new Scan for this week using only clean support and resistance structure, chart-anchored invalidation, and clear 2:1 room.",
      });
  }
}

function buildEntryReasoning(signal: VirtualTradeSignal, tradeCard: TradeConstructionResult | null) {
  return {
    conciseReasoning: signal.reason,
    whyThisWon: signal.reason,
    tradeRationale: tradeCard?.rationale ?? signal.reason,
    optionChosen: tradeCard?.buy ?? null,
    chartGeometry: null,
  };
}

async function maybeEnterVirtualTrade(params: {
  automationKey: VirtualPaperAutomationKey;
  ledger: VirtualLedger;
  allTrades: JournalTradeDetail[];
  dryRun: boolean;
}): Promise<{
  attempted: boolean;
  outcome: string;
  symbol: string | null;
  reason: string;
  orderId: null;
  journalTradeId?: string;
  tradeCard?: TradeConstructionResult;
  reasoning?: ReturnType<typeof buildEntryReasoning>;
  scanSummary?: Record<string, unknown> | null;
}> {
  const config = readPaperTraderConfig("paper");
  const excludedSymbols = openSymbols(params.allTrades);
  const scanRunId = randomUUID();
  const selected = await chooseVirtualTradeSignal({
    automationKey: params.automationKey,
    excludedSymbols,
    tradestationBaseUrlOverride: config.automationBaseUrl,
  });

  if (!selected.signal) {
    const reason = selected.warning ?? "No virtual trade signal found.";
    await recordPaperEntryCandidate({
      scanRunId,
      paperAutomationKey: params.automationKey,
      dryRun: params.dryRun,
      symbol: null,
      decision: "no_trade_today",
      decisionReason: reason,
    });
    return {
      attempted: true,
      outcome: "no_trade_today",
      symbol: null,
      reason,
      orderId: null,
      scanSummary: null,
    };
  }

  const signal = selected.signal;
  try {
    const tradeCard = await constructTradeCard({
      prompt: `build trade ${signal.symbol}`,
      confirmedDirection: signal.direction,
      confirmedConfidence: signal.confidence,
      tradestationBaseUrlOverride: config.automationBaseUrl,
      accountEquityOverride: params.ledger.currentBalanceUsd,
      ...(params.automationKey === "leaps_investor_ai"
        ? {
            targetDteMin: VIRTUAL_LEAPS_DTE_MIN,
            targetDteMax: VIRTUAL_LEAPS_DTE_MAX,
            targetDteCenter: VIRTUAL_LEAPS_DTE_CENTER,
          }
        : {}),
    });
    const automation = tradeCard.automationMetadata;
    const affordableContracts = Math.floor(params.ledger.buyingPowerUsd / (automation.optionLimitPrice * 100));
    const contracts = Math.min(automation.contracts, affordableContracts);
    if (contracts < 1) {
      const reason = `${signal.symbol} trade card passed, but the virtual book cannot afford one contract at ${automation.optionLimitPrice.toFixed(2)}.`;
      await recordPaperEntryCandidate({
        scanRunId,
        paperAutomationKey: params.automationKey,
        dryRun: params.dryRun,
        symbol: signal.symbol,
        decision: "position_cap_blocked",
        decisionReason: reason,
        selected: true,
        scan: signal.scan,
        tradeCard: tradeCard as unknown as Record<string, unknown>,
      });
      return {
        attempted: true,
        outcome: "position_cap_blocked",
        symbol: signal.symbol,
        reason,
        orderId: null,
        tradeCard,
        reasoning: buildEntryReasoning(signal, tradeCard),
      };
    }

    const positionCostUsd = Number((contracts * automation.optionLimitPrice * 100).toFixed(2));
    const now = new Date();
    const created = await createJournalTrade({
      account_mode: "paper",
      paper_automation_key: params.automationKey,
      entry_date: now.toISOString().slice(0, 10),
      entry_time: now.toISOString().slice(11, 19),
      contracts,
      option_entry_price: automation.optionLimitPrice,
      entry_notes: `Virtual ${params.automationKey} entry. No TradeStation order was placed.`,
      planned_trade: {
        ...tradeCard.plannedJournalFields,
        scan_run_id: scanRunId,
        position_cost_usd: positionCostUsd,
        planned_risk_usd: tradeCard.plannedJournalFields.planned_risk_usd * (contracts / Math.max(1, automation.contracts)),
        planned_profit_usd: tradeCard.plannedJournalFields.planned_profit_usd * (contracts / Math.max(1, automation.contracts)),
        setup_subtype: params.automationKey,
      },
      signal_snapshot_json: {
        virtualPaperAutomation: true,
        selectedSignal: signal,
        tradeCardSummary: {
          ticker: tradeCard.ticker,
          direction: tradeCard.direction,
          buy: tradeCard.buy,
          rationale: tradeCard.rationale,
          rrMath: tradeCard.rrMath,
          expectedTiming: tradeCard.expectedTiming,
        },
        automation: {
          lane: params.automationKey,
          virtualPaperBot: {
            automationKey: params.automationKey,
            optionSymbol: automation.optionSymbol,
            direction: signal.direction,
            quantity: contracts,
            requestedQuantity: contracts,
            entryOptionPrice: automation.optionLimitPrice,
            entryPricing: automation.entryPricing,
            intendedStopUnderlying: automation.intendedStopUnderlying,
            intendedTargetUnderlying: automation.intendedTargetUnderlying,
            timeExitDate: automation.timeExitDate,
            sourceType: signal.sourceType,
            sourceReason: signal.reason,
            virtualStartingBalanceUsd: params.ledger.startingBalanceUsd,
            virtualBuyingPowerUsd: params.ledger.buyingPowerUsd,
            maxPositionPct: VIRTUAL_POSITION_PCT,
            note: "Virtual journal entry only; TradeStation usage was read-only.",
          },
        },
      },
      status: "open",
    });

    const reason = `Entered virtual ${contracts}x ${automation.optionSymbol} from ${signal.sourceType}. ${signal.reason}`;
    await recordPaperEntryCandidate({
      scanRunId,
      paperAutomationKey: params.automationKey,
      dryRun: params.dryRun,
      symbol: signal.symbol,
      decision: "entered_virtual_trade",
      decisionReason: reason,
      paperTradeId: created.id,
      orderId: null,
      selected: true,
      scan: signal.scan,
      tradeCard: tradeCard as unknown as Record<string, unknown>,
    });

    return {
      attempted: true,
      outcome: "entered_virtual_trade",
      symbol: signal.symbol,
      reason,
      orderId: null,
      journalTradeId: created.id,
      tradeCard,
      reasoning: buildEntryReasoning(signal, tradeCard),
      scanSummary: signal.scan
        ? {
            conclusion: signal.scan.conclusion,
            ticker: signal.scan.ticker,
            reason: signal.scan.reason,
          }
        : { sourceType: signal.sourceType, reason: signal.reason },
    };
  } catch (error) {
    const message = error instanceof TradeCardBlockedAfterConfirmationError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    await recordPaperEntryCandidate({
      scanRunId,
      paperAutomationKey: params.automationKey,
      dryRun: params.dryRun,
      symbol: signal.symbol,
      decision: "trade_card_blocked",
      decisionReason: message,
      selected: true,
      scan: signal.scan,
    });
    return {
      attempted: true,
      outcome: "trade_card_blocked",
      symbol: signal.symbol,
      reason: message,
      orderId: null,
      reasoning: buildEntryReasoning(signal, null),
      scanSummary: signal.scan
        ? {
            conclusion: signal.scan.conclusion,
            ticker: signal.scan.ticker,
            reason: signal.scan.reason,
          }
        : { sourceType: signal.sourceType, reason: signal.reason },
    };
  }
}

async function loadVirtualTrades(automationKey: VirtualPaperAutomationKey): Promise<JournalTradeDetail[]> {
  return await listJournalTradeDetails(VIRTUAL_TRADE_HISTORY_LIMIT, {
    accountMode: "paper",
    paperAutomationKey: automationKey,
    includeSignalSnapshot: true,
  });
}

async function loadVirtualHistories(automationKey: VirtualPaperAutomationKey, includeHistory: boolean) {
  if (!includeHistory) {
    return {
      runHistory: [],
      runHistoryMigrationRequired: false,
      runHistoryMigrationMessage: null,
      entryCandidateHistory: [],
      entryCandidateHistoryMigrationRequired: false,
      entryCandidateHistoryMigrationMessage: null,
    };
  }

  const [runHistory, entryCandidateHistory] = await Promise.all([
    listRecentPaperTraderRuns(25, {
      includeRawResult: true,
      mode: "paper",
      paperAutomationKey: automationKey,
    }),
    listRecentPaperEntryCandidates(50, {
      paperAutomationKey: automationKey,
    }),
  ]);

  return {
    runHistory: runHistory.runs,
    runHistoryMigrationRequired: runHistory.migrationRequired,
    runHistoryMigrationMessage: runHistory.migrationMessage,
    entryCandidateHistory: entryCandidateHistory.candidates,
    entryCandidateHistoryMigrationRequired: entryCandidateHistory.migrationRequired,
    entryCandidateHistoryMigrationMessage: entryCandidateHistory.migrationMessage,
  };
}

export async function runVirtualPaperAutomationCycle(options: VirtualRunOptions) {
  const bot = getVirtualPaperAutomationBot(options.automationKey);
  const dryRun = options.dryRun === true;
  let allTrades = await loadVirtualTrades(options.automationKey);
  const openTradesBeforeManagement = allTrades.filter((trade) => trade.status === "open");
  const management = dryRun
    ? {
        inspected: openTradesBeforeManagement.length,
        updates: [],
        exitsTriggered: [],
        skipped: openTradesBeforeManagement.map((trade) => ({
          tradeId: trade.id,
          symbol: trade.symbol,
          reason: "Dry run requested; virtual management did not close trades.",
        })),
      }
    : await manageOpenVirtualTrades(options.automationKey, openTradesBeforeManagement);
  if (management.exitsTriggered.length > 0) {
    allTrades = await loadVirtualTrades(options.automationKey);
  }

  const ledger = buildVirtualLedger(allTrades, bot.startingBalanceUsd);
  const openTrades = allTrades.filter((trade) => trade.status === "open");
  const skipNewEntry = options.skipNewEntry === true;
  const entry = skipNewEntry
    ? {
        attempted: false,
        outcome: "monitor_only",
        symbol: null,
        reason: "Virtual monitor-only run skipped new entries.",
        orderId: null,
      }
    : await maybeEnterVirtualTrade({
        automationKey: options.automationKey,
        ledger,
        allTrades,
        dryRun,
      });
  const result = {
    mode: "paper",
    paperAutomationKey: options.automationKey,
    timestamp: new Date().toISOString(),
    dryRun,
    dryRunReason: dryRun
      ? "Dry run requested; this virtual automation did not create or close journal positions."
      : "Virtual ledger run; TradeStation usage is read-only and no broker orders are placed.",
    config: {
      automationBaseUrl: readPaperTraderConfig("paper").automationBaseUrl,
      tradeStationEnvironment: "sim",
      accountMode: "paper",
      allowOrderPlacement: false,
      accountId: "virtual-ledger",
      maxOpenTrades: null,
      maxDailyLossUsd: null,
      maxPositionPct: VIRTUAL_POSITION_PCT,
      entryOrderManagementEnabled: false,
      weekendGuardEnabled: false,
      weekendEntryCutoffMinutesCt: 0,
      weekendExitCutoffMinutesCt: 0,
      openingStopBypassEnabled: false,
    },
    guards: {
      openPaperTrades: openTrades.length,
      liveSimPositions: null,
      staleOpenJournalTrades: null,
      todayRealizedPlUsd: ledger.realizedPlUsd,
      newEntriesAllowed: !skipNewEntry,
    },
    virtualAccount: ledger,
    reconciliation: buildEmptyReconciliation(),
    closedExitReconciliation: buildEmptyClosedExitReconciliation(),
    liveDailyAudit: buildEmptyLiveDailyAudit(),
    entryOrderManagement: buildEmptyEntryOrderManagement(),
    management,
    entry,
    decisionLog: [],
    paperTradeHistory: [],
    entryCandidateHistory: [],
    entryCandidateHistoryMigrationRequired: false,
    entryCandidateHistoryMigrationMessage: null,
    runHistory: [],
    runHistoryMigrationRequired: false,
    runHistoryMigrationMessage: null,
  };

  let writeWarning: string | null = null;
  try {
    await recordPaperTraderRun({
      mode: "paper",
      paperAutomationKey: options.automationKey,
      dryRun,
      outcome: entry.outcome,
      symbol: entry.symbol,
      reason: entry.reason,
      rawResult: result,
    });
  } catch (error) {
    writeWarning = `Virtual run history write unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  const histories = await loadVirtualHistories(options.automationKey, options.includeHistory !== false);
  return {
    ...result,
    ...histories,
    runHistoryMigrationMessage: writeWarning ?? histories.runHistoryMigrationMessage,
  };
}

export async function getVirtualPaperAutomationStatus(automationKey: VirtualPaperAutomationKey) {
  const bot = getVirtualPaperAutomationBot(automationKey);
  const trades = await loadVirtualTrades(automationKey);
  const openTrades = trades.filter((trade) => trade.status === "open");
  const closedTrades = trades.filter((trade) => trade.status === "closed");
  const ledger = buildVirtualLedger(trades, bot.startingBalanceUsd);
  const histories = await loadVirtualHistories(automationKey, true);
  return {
    enabled: true,
    allowOrderPlacement: false,
    liveRunReady: true,
    automationBaseUrl: readPaperTraderConfig("paper").automationBaseUrl,
    tradeStationEnvironment: "sim",
    accountMode: "paper",
    paperAutomationKey: automationKey,
    accountIdConfigured: true,
    maxOpenTrades: null,
    maxDailyLossUsd: null,
    maxPositionPct: VIRTUAL_POSITION_PCT,
    entryOrderManagementEnabled: false,
    requiresSecret: readPaperTraderApiSecrets().length > 0,
    openPaperTrades: openTrades.length,
    liveSimPositions: null,
    staleOpenJournalTrades: null,
    virtualAccount: ledger,
    sizing: {
      accountValueUsd: ledger.currentBalanceUsd,
      beginningOfDayAccountValueUsd: bot.startingBalanceUsd,
      cashBalanceUsd: ledger.buyingPowerUsd,
      unrealizedPlUsd: 0,
      equitiesBuyingPowerUsd: ledger.buyingPowerUsd,
      optionsBuyingPowerUsd: ledger.buyingPowerUsd,
      dayTradeExcessUsd: null,
      maxPositionCostUsd: ledger.currentBalanceUsd * VIRTUAL_POSITION_PCT,
      openPositionCount: openTrades.length,
      openContractCount: openTrades.reduce((sum, trade) => sum + (trade.contracts ?? 0), 0),
      openPositionCostUsd: ledger.openPositionCostUsd,
      openPositionMarketValueUsd: ledger.openPositionCostUsd,
      positions: [],
      error: null,
    },
    configurationIssues: [],
    dataWarnings: [],
    liveDailyAudit: buildEmptyLiveDailyAudit(),
    learning: {
      learningStartAt: "1970-01-01T00:00:00.000Z",
      excludedLearningTrades: 0,
      closedLearningTrades: closedTrades.length,
      closedPaperTrades: closedTrades.length,
      closedLiveTrades: 0,
      sourceCounts: { paper: closedTrades.length, live: 0 },
      managementExperiences: closedTrades.length,
      entryExperiences: closedTrades.length,
      entryLearnedContexts: closedTrades.length,
      learnedContexts: closedTrades.length,
      readyForPolicyPrior: closedTrades.length >= 8,
      entryFeatureCoverage: {},
      entryPolicySummary: `${bot.label} uses a separate virtual $10,000 ledger. TradeStation is read-only; no broker orders are placed.`,
      entryPolicyEffectiveness: {
        evaluatedCandidates: 0,
        candidatesWithPolicy: 0,
        enteredCandidates: 0,
        closedCandidates: closedTrades.length,
        sourceCounts: { paper: closedTrades.length, live: 0 },
        policyBlockedCandidates: 0,
        shadowTrackedCandidates: 0,
        buckets: [],
        summary: "Virtual bot learning is scoped to this automation key.",
      },
    },
    recentDecisionLog: [],
    paperTradeHistory: [],
    ...histories,
  };
}
