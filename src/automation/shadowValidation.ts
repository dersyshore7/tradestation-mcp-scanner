import type { TradeConstructionResult } from "../app/runTradeConstruction.js";
import type { TradeDirection } from "../journal/types.js";
import {
  supabaseInsertAndSelectOne,
  supabaseSelect,
  supabaseUpdateAndSelectOne,
} from "../supabase/serverClient.js";
import type { PaperTraderConfig } from "./config.js";
import { createAutomationTradeStationClient } from "./tradestation.js";
import {
  strategyVersionForDirection,
  type StrategyVersionId,
} from "./strategyVersion.js";

type StrategyShadowTrade = {
  id: string;
  strategy_version: StrategyVersionId;
  session_date: string;
  symbol: string;
  direction: TradeDirection;
  option_symbol: string;
  status: "open" | "closed" | "excluded";
  entry_time: string;
  entry_underlying_price: string | null;
  entry_bid: string | null;
  entry_ask: string;
  intended_stop_underlying: string;
  intended_target_underlying: string;
  time_exit_date: string;
  planned_risk_usd: string;
  fees_usd: string;
  max_option_bid: string | null;
  min_option_bid: string | null;
  quote_observation_count: number;
  data_quality: string;
};

export type ShadowValidationCycleResult = {
  inspected: number;
  opened: number;
  updated: number;
  closed: number;
  skipped: string[];
};

function readNumber(value: string | number | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sessionDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function shadowFeePerContractUsd(): number {
  const parsed = Number(process.env.SHADOW_OPTION_FEE_PER_CONTRACT_USD ?? "1.20");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1.2;
}

function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("strategy_shadow_trades")
    && (message.includes("PGRST205") || message.toLowerCase().includes("schema cache"));
}

export async function recordProspectiveShadowTrade(params: {
  tradeCard: TradeConstructionResult;
  scanRunId: string;
  candidateId?: string | null;
  entryQuoteRaw?: unknown;
  now?: Date;
}): Promise<StrategyShadowTrade | null> {
  const now = params.now ?? new Date();
  const card = params.tradeCard;
  const automation = card.automationMetadata;
  const pricing = automation.entryPricing;
  if (!pricing || pricing.ask <= 0) {
    return null;
  }
  const strategyVersion = strategyVersionForDirection(
    card.plannedJournalFields.direction,
  );
  const date = sessionDate(now);

  try {
    const existing = await supabaseSelect<StrategyShadowTrade>({
      table: "strategy_shadow_trades",
      select: "*",
      filters: [
        `strategy_version=eq.${encodeURIComponent(strategyVersion)}`,
        `session_date=eq.${date}`,
        `symbol=eq.${encodeURIComponent(card.ticker)}`,
        "status=neq.excluded",
      ],
      limit: 1,
    });
    if (existing.length > 0) {
      return existing[0] ?? null;
    }

    return await supabaseInsertAndSelectOne<StrategyShadowTrade>({
      table: "strategy_shadow_trades",
      values: {
        strategy_version: strategyVersion,
        candidate_id: params.candidateId ?? null,
        scan_run_id: params.scanRunId,
        session_date: date,
        symbol: card.ticker,
        direction: card.plannedJournalFields.direction,
        option_symbol: automation.optionSymbol,
        status: "open",
        quantity: 1,
        entry_time: now.toISOString(),
        entry_underlying_price: automation.underlyingEntryPrice,
        entry_bid: pricing.bid,
        entry_ask: pricing.ask,
        entry_quote_json: {
          pricing,
          raw: params.entryQuoteRaw ?? null,
        },
        intended_stop_underlying: automation.intendedStopUnderlying,
        intended_target_underlying: automation.intendedTargetUnderlying,
        time_exit_date: automation.timeExitDate,
        planned_risk_usd: Math.max(
          0.01,
          card.plannedJournalFields.planned_risk_usd
            / Math.max(1, automation.contracts),
        ),
        fees_usd: shadowFeePerContractUsd(),
        max_option_bid: pricing.bid,
        min_option_bid: pricing.bid,
        quote_observation_count: 1,
        data_quality: "usable",
      },
    });
  } catch (error) {
    if (isMissingTable(error)) {
      return null;
    }
    throw error;
  }
}

function inferShadowExit(params: {
  trade: StrategyShadowTrade;
  underlyingLast: number | null;
  optionBid: number | null;
  today: string;
}): string | null {
  const stop = readNumber(params.trade.intended_stop_underlying);
  const target = readNumber(params.trade.intended_target_underlying);
  const entryAsk = readNumber(params.trade.entry_ask);
  if (params.trade.direction === "CALL" && params.underlyingLast !== null) {
    if (stop !== null && params.underlyingLast <= stop) return "stop_hit";
    if (target !== null && params.underlyingLast >= target) return "target_hit";
  }
  if (params.trade.direction === "PUT" && params.underlyingLast !== null) {
    if (stop !== null && params.underlyingLast >= stop) return "stop_hit";
    if (target !== null && params.underlyingLast <= target) return "target_hit";
  }
  if (entryAsk !== null && params.optionBid !== null && params.optionBid <= entryAsk * 0.75) {
    return "premium_stop";
  }
  if (params.today >= params.trade.time_exit_date) {
    return "time_exit";
  }
  return null;
}

export async function updateProspectiveShadowTrades(
  config: PaperTraderConfig,
): Promise<ShadowValidationCycleResult> {
  const result: ShadowValidationCycleResult = {
    inspected: 0,
    opened: 0,
    updated: 0,
    closed: 0,
    skipped: [],
  };
  if (config.accountMode !== "live") {
    return result;
  }

  let trades: StrategyShadowTrade[];
  try {
    trades = await supabaseSelect<StrategyShadowTrade>({
      table: "strategy_shadow_trades",
      select: "*",
      filters: ["status=eq.open"],
      order: ["entry_time.asc"],
      limit: 500,
    });
  } catch (error) {
    if (isMissingTable(error)) {
      result.skipped.push("Shadow validation migration has not been applied.");
      return result;
    }
    throw error;
  }
  if (trades.length === 0) {
    return result;
  }

  const client = await createAutomationTradeStationClient(config.automationBaseUrl);
  const today = sessionDate();
  for (const trade of trades) {
    result.inspected += 1;
    try {
      const [optionQuote, underlyingQuote] = await Promise.all([
        client.fetchQuote(trade.option_symbol),
        client.fetchQuote(trade.symbol),
      ]);
      if (optionQuote.bid === null || optionQuote.bid <= 0) {
        result.skipped.push(`${trade.symbol}: missing executable option bid.`);
        continue;
      }
      const entryAsk = readNumber(trade.entry_ask);
      const plannedRiskUsd = readNumber(trade.planned_risk_usd);
      if (entryAsk === null || entryAsk <= 0 || plannedRiskUsd === null || plannedRiskUsd <= 0) {
        await supabaseUpdateAndSelectOne<StrategyShadowTrade>({
          table: "strategy_shadow_trades",
          filters: [`id=eq.${trade.id}`],
          values: {
            status: "excluded",
            data_quality: "unresolved",
            exclusion_reason: "Missing entry ask or planned risk.",
            updated_at: new Date().toISOString(),
          },
        });
        result.updated += 1;
        continue;
      }

      const maxOptionBid = Math.max(readNumber(trade.max_option_bid) ?? optionQuote.bid, optionQuote.bid);
      const minOptionBid = Math.min(readNumber(trade.min_option_bid) ?? optionQuote.bid, optionQuote.bid);
      const exitReason = inferShadowExit({
        trade,
        underlyingLast: underlyingQuote.last,
        optionBid: optionQuote.bid,
        today,
      });
      const commonValues = {
        max_option_bid: maxOptionBid,
        min_option_bid: minOptionBid,
        mfe_usd: Number(((maxOptionBid - entryAsk) * 100).toFixed(2)),
        mae_usd: Number(((minOptionBid - entryAsk) * 100).toFixed(2)),
        quote_observation_count: trade.quote_observation_count + 1,
        updated_at: new Date().toISOString(),
      };

      if (!exitReason) {
        await supabaseUpdateAndSelectOne<StrategyShadowTrade>({
          table: "strategy_shadow_trades",
          filters: [`id=eq.${trade.id}`],
          values: commonValues,
        });
        result.updated += 1;
        continue;
      }

      const feesUsd = readNumber(trade.fees_usd) ?? shadowFeePerContractUsd();
      const realizedPlUsd = ((optionQuote.bid - entryAsk) * 100) - feesUsd;
      await supabaseUpdateAndSelectOne<StrategyShadowTrade>({
        table: "strategy_shadow_trades",
        filters: [`id=eq.${trade.id}`],
        values: {
          ...commonValues,
          status: "closed",
          exit_time: new Date().toISOString(),
          exit_reason: exitReason,
          exit_underlying_price: underlyingQuote.last,
          exit_bid: optionQuote.bid,
          exit_quote_json: {
            option: optionQuote.raw,
            underlying: underlyingQuote.raw,
          },
          realized_pl_usd: Number(realizedPlUsd.toFixed(2)),
          realized_r_multiple: Number((realizedPlUsd / plannedRiskUsd).toFixed(4)),
          data_quality: "usable",
        },
      });
      result.updated += 1;
      result.closed += 1;
    } catch (error) {
      result.skipped.push(
        `${trade.symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}
