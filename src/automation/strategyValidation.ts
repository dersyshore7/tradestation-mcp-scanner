import {
  supabaseSelect,
  supabaseUpdateAndSelectOne,
} from "../supabase/serverClient.js";
import type { TradeDirection } from "../journal/types.js";
import type {
  StrategyLifecycleStatus,
  StrategyVersionId,
} from "./strategyVersion.js";

export const STRATEGY_PROMOTION_REQUIREMENTS = {
  minimumClosedTrades: 100,
  minimumTradingDays: 60,
  minimumProfitFactor: 1.2,
  maximumDrawdownPct: 0.1,
  minimumDataCompleteness: 0.95,
  maximumSingleTradeProfitContributionPct: 0.2,
} as const;

export type StrategyVersionRecord = {
  version: StrategyVersionId;
  direction: TradeDirection;
  status: StrategyLifecycleStatus;
  config_json: Record<string, unknown>;
  code_commit_sha: string;
  shadow_account_value_usd: string;
  validation_started_at: string;
  promoted_at: string | null;
  retired_at: string | null;
  validation_summary_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type StrategyShadowTradeRecord = {
  id: string;
  strategy_version: StrategyVersionId;
  session_date: string;
  entry_time: string;
  status: "open" | "closed" | "excluded";
  realized_pl_usd: string | null;
  realized_r_multiple: string | null;
  data_quality: "usable" | "provisional" | "missing_quote" | "unresolved" | "excluded";
};

export type StrategyValidationGate = {
  key: string;
  passed: boolean;
  actual: number | boolean | null;
  required: string;
};

export type StrategyValidationSummary = {
  strategyVersion: StrategyVersionId;
  totalTrades: number;
  closedTrades: number;
  usableClosedTrades: number;
  tradingDays: number;
  netProfitUsd: number;
  profitFactor: number | null;
  meanRealizedR: number | null;
  holdoutNetProfitUsd: number | null;
  holdoutPositive: boolean;
  maximumDrawdownPct: number | null;
  dataCompleteness: number;
  largestProfitContributionPct: number | null;
  gates: StrategyValidationGate[];
  promotable: boolean;
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

export function calculateStrategyValidationSummary(
  strategyVersion: StrategyVersionId,
  trades: StrategyShadowTradeRecord[],
  shadowAccountValueUsd = 10_000,
): StrategyValidationSummary {
  const closedTrades = trades.filter((trade) => trade.status === "closed");
  const usable = closedTrades
    .map((trade) => ({
      ...trade,
      pl: readNumber(trade.realized_pl_usd),
      r: readNumber(trade.realized_r_multiple),
    }))
    .filter((trade): trade is typeof trade & { pl: number; r: number } =>
      trade.data_quality === "usable" && trade.pl !== null && trade.r !== null
    )
    .sort((left, right) => left.entry_time.localeCompare(right.entry_time));
  const grossProfit = usable.reduce((sum, trade) => sum + Math.max(0, trade.pl), 0);
  const grossLoss = Math.abs(usable.reduce((sum, trade) => sum + Math.min(0, trade.pl), 0));
  const netProfitUsd = grossProfit - grossLoss;
  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0
      ? Number.POSITIVE_INFINITY
      : null;
  const meanRealizedR = usable.length > 0
    ? usable.reduce((sum, trade) => sum + trade.r, 0) / usable.length
    : null;
  const holdoutStart = Math.floor(usable.length * 0.7);
  const holdout = usable.slice(holdoutStart);
  const holdoutNetProfitUsd = holdout.length > 0
    ? holdout.reduce((sum, trade) => sum + trade.pl, 0)
    : null;

  let equity = shadowAccountValueUsd;
  let peak = shadowAccountValueUsd;
  let maximumDrawdownPct = 0;
  for (const trade of usable) {
    equity += trade.pl;
    peak = Math.max(peak, equity);
    maximumDrawdownPct = Math.max(
      maximumDrawdownPct,
      peak > 0 ? (peak - equity) / peak : 1,
    );
  }

  const largestProfit = usable.reduce((largest, trade) => Math.max(largest, trade.pl), 0);
  const largestProfitContributionPct = netProfitUsd > 0
    ? largestProfit / netProfitUsd
    : null;
  const dataCompleteness = closedTrades.length > 0
    ? usable.length / closedTrades.length
    : 0;
  const tradingDays = new Set(usable.map((trade) => trade.session_date)).size;
  const requirements = STRATEGY_PROMOTION_REQUIREMENTS;
  const gates: StrategyValidationGate[] = [
    {
      key: "closed_trades",
      passed: usable.length >= requirements.minimumClosedTrades,
      actual: usable.length,
      required: `>= ${requirements.minimumClosedTrades}`,
    },
    {
      key: "trading_days",
      passed: tradingDays >= requirements.minimumTradingDays,
      actual: tradingDays,
      required: `>= ${requirements.minimumTradingDays}`,
    },
    {
      key: "profit_factor",
      passed: profitFactor !== null && profitFactor >= requirements.minimumProfitFactor,
      actual: profitFactor,
      required: `>= ${requirements.minimumProfitFactor.toFixed(2)}`,
    },
    {
      key: "positive_mean_r",
      passed: meanRealizedR !== null && meanRealizedR > 0,
      actual: meanRealizedR,
      required: "> 0",
    },
    {
      key: "positive_holdout",
      passed: holdoutNetProfitUsd !== null && holdoutNetProfitUsd > 0,
      actual: holdoutNetProfitUsd,
      required: "> 0 USD",
    },
    {
      key: "maximum_drawdown",
      passed: maximumDrawdownPct <= requirements.maximumDrawdownPct,
      actual: maximumDrawdownPct,
      required: `<= ${(requirements.maximumDrawdownPct * 100).toFixed(0)}%`,
    },
    {
      key: "data_completeness",
      passed: dataCompleteness >= requirements.minimumDataCompleteness,
      actual: dataCompleteness,
      required: `>= ${(requirements.minimumDataCompleteness * 100).toFixed(0)}%`,
    },
    {
      key: "outlier_contribution",
      passed:
        largestProfitContributionPct !== null
        && largestProfitContributionPct <= requirements.maximumSingleTradeProfitContributionPct,
      actual: largestProfitContributionPct,
      required: `<= ${(requirements.maximumSingleTradeProfitContributionPct * 100).toFixed(0)}%`,
    },
  ];

  return {
    strategyVersion,
    totalTrades: trades.length,
    closedTrades: closedTrades.length,
    usableClosedTrades: usable.length,
    tradingDays,
    netProfitUsd: Number(netProfitUsd.toFixed(2)),
    profitFactor,
    meanRealizedR,
    holdoutNetProfitUsd:
      holdoutNetProfitUsd === null ? null : Number(holdoutNetProfitUsd.toFixed(2)),
    holdoutPositive: holdoutNetProfitUsd !== null && holdoutNetProfitUsd > 0,
    maximumDrawdownPct,
    dataCompleteness,
    largestProfitContributionPct,
    gates,
    promotable: gates.every((gate) => gate.passed),
  };
}

export async function listStrategyVersions(): Promise<StrategyVersionRecord[]> {
  return await supabaseSelect<StrategyVersionRecord>({
    table: "strategy_versions",
    select: "*",
    order: ["created_at.asc"],
  });
}

export async function getStrategyVersion(
  version: StrategyVersionId,
): Promise<StrategyVersionRecord | null> {
  const rows = await supabaseSelect<StrategyVersionRecord>({
    table: "strategy_versions",
    select: "*",
    filters: [`version=eq.${encodeURIComponent(version)}`],
    limit: 1,
  });
  return rows[0] ?? null;
}

export async function getStrategyValidation(
  version: StrategyVersionId,
): Promise<{
  strategy: StrategyVersionRecord;
  validation: StrategyValidationSummary;
}> {
  const strategy = await getStrategyVersion(version);
  if (!strategy) {
    throw new Error(`Unknown strategy version: ${version}`);
  }
  const trades = await supabaseSelect<StrategyShadowTradeRecord>({
    table: "strategy_shadow_trades",
    select: "id,strategy_version,session_date,entry_time,status,realized_pl_usd,realized_r_multiple,data_quality",
    filters: [`strategy_version=eq.${encodeURIComponent(version)}`],
    order: ["entry_time.asc"],
    limit: 5_000,
  });
  return {
    strategy,
    validation: calculateStrategyValidationSummary(
      version,
      trades,
      readNumber(strategy.shadow_account_value_usd) ?? 10_000,
    ),
  };
}

export async function changeStrategyLifecycle(params: {
  version: StrategyVersionId;
  status: StrategyLifecycleStatus;
}): Promise<{
  strategy: StrategyVersionRecord;
  validation: StrategyValidationSummary;
}> {
  const current = await getStrategyValidation(params.version);
  if (params.status === "promoted" && !current.validation.promotable) {
    const failures = current.validation.gates
      .filter((gate) => !gate.passed)
      .map((gate) => `${gate.key} ${String(gate.actual)} (requires ${gate.required})`);
    throw new Error(`Strategy promotion blocked: ${failures.join("; ")}`);
  }
  if (current.strategy.status === "retired" && params.status !== "retired") {
    throw new Error("Retired strategy versions cannot be reactivated; create a new version.");
  }

  const now = new Date().toISOString();
  const strategy = await supabaseUpdateAndSelectOne<StrategyVersionRecord>({
    table: "strategy_versions",
    filters: [`version=eq.${encodeURIComponent(params.version)}`],
    values: {
      status: params.status,
      validation_summary_json: current.validation,
      updated_at: now,
      promoted_at: params.status === "promoted"
        ? current.strategy.promoted_at ?? now
        : current.strategy.promoted_at,
      retired_at: params.status === "retired" ? now : null,
    },
  });
  return { strategy, validation: current.validation };
}
