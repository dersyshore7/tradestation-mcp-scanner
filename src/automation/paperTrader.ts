import { buildWorkflowPresentationSummary } from "../app/resultPresentation.js";
import {
  extractFinalizedTradeGeometryFromTelemetry,
  runScan,
} from "../app/runScan.js";
import {
  constructTradeCard,
  type TradeConstructionResult,
} from "../app/runTradeConstruction.js";
import {
  closeJournalTrade,
  createJournalTrade,
  listJournalTradeDetails,
} from "../journal/repository.js";
import type { JournalTradeDetail } from "../journal/types.js";
import {
  assertPaperTraderConfig,
  readPaperTraderConfig,
  type PaperTraderConfig,
} from "./config.js";
import {
  createAutomationTradeStationClient,
  extractAverageFillPrice,
  type TradeStationOrderRequest,
} from "./tradestation.js";

type PaperTraderRunOptions = {
  prompt?: string;
  dryRun?: boolean;
  source?: "api" | "cli";
};

type AutomationSnapshot = {
  automation?: {
    lane?: string;
    paperTrader?: {
      accountId?: string;
      optionSymbol?: string;
      quantity?: number;
      entryOrderType?: "Limit";
      entryTradeAction?: "BUYTOOPEN";
      entryLimitPrice?: number;
      intendedStopUnderlying?: number;
      intendedTargetUnderlying?: number;
      timeExitDate?: string;
      orderId?: string | null;
    };
  };
};

type PaperTraderAutomationSnapshot = NonNullable<
  NonNullable<AutomationSnapshot["automation"]>["paperTrader"]
>;

type ExitDecision = {
  reason: "target_hit" | "stop_hit" | "time_exit" | "manual_early_exit";
  note: string;
};

type PaperTraderStatus = {
  enabled: boolean;
  allowOrderPlacement: boolean;
  automationBaseUrl: string;
  accountIdConfigured: boolean;
  maxOpenTrades: number;
  maxDailyLossUsd: number;
  requiresSecret: boolean;
  openPaperTrades: number;
};

type PaperTraderRunResult = {
  mode: "paper";
  timestamp: string;
  dryRun: boolean;
  config: {
    automationBaseUrl: string;
    allowOrderPlacement: boolean;
    accountId: string;
    maxOpenTrades: number;
    maxDailyLossUsd: number;
  };
  guards: {
    openPaperTrades: number;
    todayRealizedPlUsd: number;
    newEntriesAllowed: boolean;
  };
  management: {
    inspected: number;
    exitsTriggered: {
      tradeId: string;
      symbol: string;
      reason: ExitDecision["reason"];
      action: "closed" | "would_close" | "skipped";
      orderId: string | null;
      optionExitPrice: number | null;
      note: string;
    }[];
    skipped: {
      tradeId: string;
      symbol: string;
      reason: string;
    }[];
  };
  entry: {
    attempted: boolean;
    outcome:
      | "skipped_after_guard"
      | "no_trade_today"
      | "trade_card_blocked"
      | "zero_contract_trade"
      | "preview_only"
      | "entered_paper_trade";
    symbol: string | null;
    reason: string;
    orderId?: string | null;
    journalTradeId?: string | null;
    tradeCard?: TradeConstructionResult | null;
  };
};

function readNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function formatChicagoParts(date = new Date()): {
  date: string;
  time: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  };
}

function toChicagoDateString(isoTimestamp: string): string {
  return formatChicagoParts(new Date(isoTimestamp)).date;
}

function buildScanRunId(): string {
  return `paper_scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function readAutomationSnapshot(
  trade: JournalTradeDetail,
): PaperTraderAutomationSnapshot | null {
  const snapshot = trade.signal_snapshot_json as AutomationSnapshot | null;
  return snapshot?.automation?.paperTrader ?? null;
}

function computeTodayRealizedPlUsd(
  trades: JournalTradeDetail[],
  todayChicago: string,
): number {
  return trades
    .filter((trade) =>
      trade.account_mode === "paper"
      && trade.status === "closed"
      && trade.latest_exit
      && toChicagoDateString(trade.latest_exit.exit_time) === todayChicago
    )
    .reduce(
      (sum, trade) => sum + (readNumber(trade.review?.realized_pl_usd ?? null) ?? 0),
      0,
    );
}

function inferExitDecision(params: {
  trade: JournalTradeDetail;
  automation: NonNullable<ReturnType<typeof readAutomationSnapshot>>;
  todayChicago: string;
  underlyingLast: number | null;
  optionMid: number | null;
}): ExitDecision | null {
  const stop =
    params.automation.intendedStopUnderlying
    ?? readNumber(params.trade.intended_stop_underlying);
  const target =
    params.automation.intendedTargetUnderlying
    ?? readNumber(params.trade.intended_target_underlying);
  const timeExitDate = params.automation.timeExitDate ?? null;
  const entryOptionPrice = readNumber(params.trade.option_entry_price);

  if (params.trade.direction === "CALL" && params.underlyingLast !== null) {
    if (typeof stop === "number" && params.underlyingLast <= stop) {
      return {
        reason: "stop_hit",
        note: `Underlying fell to ${params.underlyingLast.toFixed(2)} at/below stop ${stop.toFixed(2)}.`,
      };
    }
    if (typeof target === "number" && params.underlyingLast >= target) {
      return {
        reason: "target_hit",
        note: `Underlying rose to ${params.underlyingLast.toFixed(2)} at/above target ${target.toFixed(2)}.`,
      };
    }
  }

  if (params.trade.direction === "PUT" && params.underlyingLast !== null) {
    if (typeof stop === "number" && params.underlyingLast >= stop) {
      return {
        reason: "stop_hit",
        note: `Underlying rose to ${params.underlyingLast.toFixed(2)} at/above stop ${stop.toFixed(2)}.`,
      };
    }
    if (typeof target === "number" && params.underlyingLast <= target) {
      return {
        reason: "target_hit",
        note: `Underlying fell to ${params.underlyingLast.toFixed(2)} at/below target ${target.toFixed(2)}.`,
      };
    }
  }

  if (timeExitDate && params.todayChicago >= timeExitDate) {
    return {
      reason: "time_exit",
      note: `Time exit reached on ${timeExitDate}.`,
    };
  }

  if (
    params.optionMid !== null
    && entryOptionPrice !== null
    && entryOptionPrice > 0
    && params.optionMid <= entryOptionPrice * 0.75
  ) {
    return {
      reason: "manual_early_exit",
      note: `Option premium decayed to ${params.optionMid.toFixed(2)}, beyond the 25% decay rule from ${entryOptionPrice.toFixed(2)}.`,
    };
  }

  return null;
}

export async function getPaperTraderStatus(): Promise<PaperTraderStatus> {
  const config = readPaperTraderConfig();
  const trades = await listJournalTradeDetails(200);

  return {
    enabled: config.enabled,
    allowOrderPlacement: config.allowOrderPlacement,
    automationBaseUrl: config.automationBaseUrl,
    accountIdConfigured: config.accountId !== null,
    maxOpenTrades: config.maxOpenTrades,
    maxDailyLossUsd: config.maxDailyLossUsd,
    requiresSecret: config.apiSecret !== null,
    openPaperTrades: trades.filter(
      (trade) => trade.account_mode === "paper" && trade.status === "open",
    ).length,
  };
}

async function manageOpenPaperTrades(
  config: PaperTraderConfig,
  dryRun: boolean,
  allTrades: JournalTradeDetail[],
): Promise<PaperTraderRunResult["management"]> {
  const openPaperTrades = allTrades.filter(
    (trade) => trade.account_mode === "paper" && trade.status === "open",
  );
  const client = await createAutomationTradeStationClient(config.automationBaseUrl);
  const nowIso = new Date().toISOString();
  const todayChicago = formatChicagoParts(new Date()).date;
  const exitsTriggered: PaperTraderRunResult["management"]["exitsTriggered"] = [];
  const skipped: PaperTraderRunResult["management"]["skipped"] = [];

  for (const trade of openPaperTrades) {
    const automation = readAutomationSnapshot(trade);
    if (!automation?.optionSymbol || !automation.accountId || !automation.quantity) {
      skipped.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: "Missing automation metadata required for position management.",
      });
      continue;
    }

    const [underlyingQuote, optionQuote] = await Promise.all([
      client.fetchQuote(trade.symbol),
      client.fetchQuote(automation.optionSymbol),
    ]);
    const decision = inferExitDecision({
      trade,
      automation,
      todayChicago,
      underlyingLast: underlyingQuote.last,
      optionMid: optionQuote.mid,
    });

    if (!decision) {
      skipped.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: "No stop, target, time, or premium-decay exit trigger fired.",
      });
      continue;
    }

    if (dryRun) {
      exitsTriggered.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: decision.reason,
        action: "would_close",
        orderId: automation.orderId ?? null,
        optionExitPrice: optionQuote.mid,
        note: decision.note,
      });
      continue;
    }

    const exitOrder: TradeStationOrderRequest = {
      accountId: automation.accountId,
      symbol: automation.optionSymbol,
      quantity: automation.quantity,
      orderType: "Market",
      tradeAction: "SELLTOCLOSE",
      duration: "DAY",
    };
    const orderResult = await client.placeOrder(exitOrder);
    let optionExitPrice = orderResult.averageFillPrice;
    if (optionExitPrice === null && orderResult.orderId) {
      const executions = await client.getExecutions(
        automation.accountId,
        orderResult.orderId,
      );
      optionExitPrice = extractAverageFillPrice(executions);
    }
    if (optionExitPrice === null) {
      optionExitPrice =
        optionQuote.mid
        ?? optionQuote.bid
        ?? readNumber(trade.option_entry_price);
    }
    if (optionExitPrice === null || optionExitPrice <= 0) {
      exitsTriggered.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: decision.reason,
        action: "skipped",
        orderId: orderResult.orderId,
        optionExitPrice: null,
        note: `${decision.note} Exit order was sent, but no usable fill price was available for journaling.`,
      });
      continue;
    }

    await closeJournalTrade(trade.id, {
      option_exit_price: optionExitPrice,
      exit_reason: decision.reason,
      exit_timestamp: nowIso,
      quantity_closed: automation.quantity,
      fees_usd: 0,
      slippage_usd: 0,
      exit_notes: `Paper trader auto-exit. ${decision.note}`,
      lessons_learned: null,
      review_notes: `Paper trader auto-managed exit from ${automation.optionSymbol}.`,
    });

    exitsTriggered.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      reason: decision.reason,
      action: "closed",
      orderId: orderResult.orderId,
      optionExitPrice,
      note: decision.note,
    });
  }

  return {
    inspected: openPaperTrades.length,
    exitsTriggered,
    skipped,
  };
}

async function maybeEnterNewPaperTrade(params: {
  config: PaperTraderConfig;
  dryRun: boolean;
  openPaperTrades: JournalTradeDetail[];
  todayRealizedPlUsd: number;
  prompt: string;
}): Promise<PaperTraderRunResult["entry"]> {
  const {
    config,
    dryRun,
    openPaperTrades,
    todayRealizedPlUsd,
    prompt,
  } = params;

  if (openPaperTrades.length >= config.maxOpenTrades) {
    return {
      attempted: false,
      outcome: "skipped_after_guard",
      symbol: null,
      reason: `Max open paper trades reached (${openPaperTrades.length}/${config.maxOpenTrades}).`,
    };
  }

  if (todayRealizedPlUsd <= -config.maxDailyLossUsd) {
    return {
      attempted: false,
      outcome: "skipped_after_guard",
      symbol: null,
      reason: `Daily realized paper loss guard hit (${todayRealizedPlUsd.toFixed(2)} <= -${config.maxDailyLossUsd.toFixed(2)}).`,
    };
  }

  const scanRunId = buildScanRunId();
  const scan = await runScan({
    prompt,
    excludedTickers: openPaperTrades.map((trade) => trade.symbol),
    tradestationBaseUrlOverride: config.automationBaseUrl,
  });

  if (
    scan.conclusion !== "confirmed"
    || !scan.ticker
    || !scan.direction
    || !scan.confidence
  ) {
    return {
      attempted: true,
      outcome: "no_trade_today",
      symbol: scan.ticker,
      reason: scan.reason,
    };
  }

  try {
    const finalizedTradeGeometry = extractFinalizedTradeGeometryFromTelemetry(
      scan.telemetry,
      scan.ticker,
    );
    const tradeCard = await constructTradeCard({
      prompt: `build trade ${scan.ticker}`,
      confirmedDirection: scan.direction,
      confirmedConfidence: scan.confidence,
      ...(finalizedTradeGeometry ? { finalizedTradeGeometry } : {}),
      tradestationBaseUrlOverride: config.automationBaseUrl,
    });

    const automation = tradeCard.automationMetadata;
    if (automation.contracts < 1) {
      return {
        attempted: true,
        outcome: "zero_contract_trade",
        symbol: scan.ticker,
        reason: `Trade card sized ${automation.contracts} contracts, so the paper trader skipped the entry.`,
        tradeCard,
      };
    }

    const client = await createAutomationTradeStationClient(config.automationBaseUrl);
    const entryOrder: TradeStationOrderRequest = {
      accountId: config.accountId as string,
      symbol: automation.optionSymbol,
      quantity: automation.contracts,
      orderType: automation.entryOrderType,
      tradeAction: automation.entryTradeAction,
      limitPrice: automation.optionLimitPrice,
      duration: "DAY",
    };
    const confirmation = await client.confirmOrder(entryOrder);
    if (dryRun) {
      return {
        attempted: true,
        outcome: "preview_only",
        symbol: scan.ticker,
        reason: `Previewed ${automation.contracts}x ${automation.optionSymbol} without sending the order.`,
        tradeCard,
      };
    }

    const orderResult = await client.placeOrder(entryOrder);
    let optionEntryPrice = orderResult.averageFillPrice ?? automation.optionLimitPrice;
    if (orderResult.orderId) {
      const executions = await client.getExecutions(
        config.accountId as string,
        orderResult.orderId,
      );
      optionEntryPrice = extractAverageFillPrice(executions) ?? optionEntryPrice;
    }

    const now = new Date();
    const chicagoNow = formatChicagoParts(now);
    const presentationSummary = buildWorkflowPresentationSummary({
      scan,
      telemetry: scan.telemetry ?? null,
      tradeCard,
    });

    const createdTrade = await createJournalTrade({
      account_mode: "paper",
      entry_date: chicagoNow.date,
      entry_time: chicagoNow.time,
      contracts: automation.contracts,
      option_entry_price: optionEntryPrice,
      entry_notes: "Entered automatically by paper trader module.",
      planned_trade: {
        ...tradeCard.plannedJournalFields,
        scan_run_id: scanRunId,
      },
      signal_snapshot_json: {
        scan,
        telemetry: scan.telemetry ?? null,
        presentationSummary,
        tradeCard,
        automation: {
          lane: "paper_trader_v1",
          paperTrader: {
            accountId: config.accountId,
            optionSymbol: automation.optionSymbol,
            quantity: automation.contracts,
            entryOrderType: automation.entryOrderType,
            entryTradeAction: automation.entryTradeAction,
            entryLimitPrice: automation.optionLimitPrice,
            intendedStopUnderlying: automation.intendedStopUnderlying,
            intendedTargetUnderlying: automation.intendedTargetUnderlying,
            timeExitDate: automation.timeExitDate,
            orderId: orderResult.orderId,
            confirmationStatus: confirmation.status,
            orderStatus: orderResult.status,
          },
        },
      },
      status: "open",
    });

    return {
      attempted: true,
      outcome: "entered_paper_trade",
      symbol: scan.ticker,
      reason: `Entered ${automation.contracts}x ${automation.optionSymbol} in the paper account.`,
      orderId: orderResult.orderId,
      journalTradeId: createdTrade.id,
      tradeCard,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trade construction failed.";
    return {
      attempted: true,
      outcome: "trade_card_blocked",
      symbol: scan.ticker,
      reason: message,
    };
  }
}

export async function runPaperTraderCycle(
  options: PaperTraderRunOptions = {},
): Promise<PaperTraderRunResult> {
  const config = readPaperTraderConfig();
  assertPaperTraderConfig(config);

  const dryRun = options.dryRun ?? !config.allowOrderPlacement;
  const allTrades = await listJournalTradeDetails(200);
  const openPaperTrades = allTrades.filter(
    (trade) => trade.account_mode === "paper" && trade.status === "open",
  );
  const todayChicago = formatChicagoParts(new Date()).date;
  const todayRealizedPlUsd = computeTodayRealizedPlUsd(allTrades, todayChicago);

  const management = await manageOpenPaperTrades(config, dryRun, allTrades);
  const remainingOpenPaperTrades = openPaperTrades.filter(
    (trade) =>
      !management.exitsTriggered.some(
        (exit) => exit.tradeId === trade.id && exit.action === "closed",
      ),
  );
  const entry = await maybeEnterNewPaperTrade({
    config,
    dryRun,
    openPaperTrades: remainingOpenPaperTrades,
    todayRealizedPlUsd,
    prompt: options.prompt ?? config.scanPrompt,
  });

  return {
    mode: "paper",
    timestamp: new Date().toISOString(),
    dryRun,
    config: {
      automationBaseUrl: config.automationBaseUrl,
      allowOrderPlacement: config.allowOrderPlacement,
      accountId: config.accountId as string,
      maxOpenTrades: config.maxOpenTrades,
      maxDailyLossUsd: config.maxDailyLossUsd,
    },
    guards: {
      openPaperTrades: remainingOpenPaperTrades.length,
      todayRealizedPlUsd,
      newEntriesAllowed:
        remainingOpenPaperTrades.length < config.maxOpenTrades
        && todayRealizedPlUsd > -config.maxDailyLossUsd,
    },
    management,
    entry,
  };
}
