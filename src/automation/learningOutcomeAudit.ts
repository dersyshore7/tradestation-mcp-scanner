import type { AccountMode, JournalTradeDetail } from "../journal/types.js";
import { calculateEntryOpportunityRewardR } from "./entryRewardModel.js";

export type LearningOutcomeClass =
  | "winner_final_positive"
  | "bad_or_unproven_entry"
  | "tiny_green_then_failed"
  | "good_entry_major_giveback"
  | "missing_realized_r";

export type LearningOutcomeTradeAudit = {
  id: string;
  symbol: string;
  accountMode: AccountMode;
  direction: JournalTradeDetail["direction"];
  outcomeClass: LearningOutcomeClass;
  realizedR: number | null;
  opportunityR: number | null;
  peakOptionReturnPct: number | null;
  exitReason: string | null;
  actions: string[];
};

export type LearningOutcomeSymbolAudit = {
  symbol: string;
  tradeCount: number;
  realizedRCount: number;
  winnerCount: number;
  loserCount: number;
  winRate: number | null;
  totalRealizedR: number;
  totalOpportunityR: number;
  averageRealizedR: number | null;
  averageOpportunityR: number | null;
  bestOpportunityR: number | null;
  worstRealizedR: number | null;
  classificationCounts: Record<LearningOutcomeClass, number>;
};

export type LearningOutcomeAudit = {
  accountMode: AccountMode | "all";
  tradeCount: number;
  closedTradeCount: number;
  realizedRCount: number;
  missingRealizedRCount: number;
  totalRealizedR: number;
  totalOpportunityR: number;
  classificationCounts: Record<LearningOutcomeClass, number>;
  bySymbol: LearningOutcomeSymbolAudit[];
  worstSymbols: LearningOutcomeSymbolAudit[];
  missingRealizedRTrades: LearningOutcomeTradeAudit[];
  tradeClassifications: LearningOutcomeTradeAudit[];
  dataWarnings: string[];
};

const OUTCOME_CLASSES: LearningOutcomeClass[] = [
  "winner_final_positive",
  "bad_or_unproven_entry",
  "tiny_green_then_failed",
  "good_entry_major_giveback",
  "missing_realized_r",
];

function emptyClassCounts(): Record<LearningOutcomeClass, number> {
  return OUTCOME_CLASSES.reduce(
    (counts, outcomeClass) => ({ ...counts, [outcomeClass]: 0 }),
    {} as Record<LearningOutcomeClass, number>,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function readManagementHistory(trade: JournalTradeDetail): Record<string, unknown>[] {
  const snapshot = asRecord(trade.signal_snapshot_json);
  const automation = asRecord(snapshot?.automation);
  const paperTrader = asRecord(automation?.paperTrader);
  return Array.isArray(paperTrader?.managementHistory)
    ? paperTrader.managementHistory
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function readPeakOptionReturnPct(trade: JournalTradeDetail): number | null {
  const snapshot = asRecord(trade.signal_snapshot_json);
  const automation = asRecord(snapshot?.automation);
  const paperTrader = asRecord(automation?.paperTrader);
  const profitProtectionState = asRecord(paperTrader?.profitProtectionState);
  const storedPeak = asFiniteNumber(profitProtectionState?.peakOptionReturnPct);
  const historyPeak = readManagementHistory(trade)
    .map((item) => asFiniteNumber(item.optionReturnPct))
    .filter((value): value is number => value !== null)
    .reduce<number | null>(
      (peak, value) => peak === null ? value : Math.max(peak, value),
      null,
    );

  if (storedPeak === null) {
    return historyPeak;
  }
  if (historyPeak === null) {
    return storedPeak;
  }
  return Math.max(storedPeak, historyPeak);
}

function readManagementActions(trade: JournalTradeDetail): string[] {
  const actions = readManagementHistory(trade)
    .map((item) => typeof item.action === "string" ? item.action : null)
    .filter((value): value is string => value !== null);
  return [...new Set(actions)];
}

function classifyOutcome(realizedR: number | null, opportunityR: number | null): LearningOutcomeClass {
  if (realizedR === null) {
    return "missing_realized_r";
  }
  if (realizedR > 0) {
    return "winner_final_positive";
  }
  if (opportunityR !== null && opportunityR >= 0.5) {
    return "good_entry_major_giveback";
  }
  if (opportunityR !== null && opportunityR > 0) {
    return "tiny_green_then_failed";
  }
  return "bad_or_unproven_entry";
}

function isLearningTrade(trade: JournalTradeDetail, accountMode: AccountMode | "all"): boolean {
  return (
    trade.status === "closed" &&
    (trade.account_mode === "paper" || trade.account_mode === "live") &&
    (accountMode === "all" || trade.account_mode === accountMode)
  );
}

function buildTradeAudit(trade: JournalTradeDetail): LearningOutcomeTradeAudit {
  const realizedR = asFiniteNumber(trade.review?.realized_r_multiple);
  const opportunityR = realizedR === null
    ? null
    : calculateEntryOpportunityRewardR(trade, realizedR);
  const outcomeClass = classifyOutcome(realizedR, opportunityR);
  return {
    id: trade.id,
    symbol: trade.symbol,
    accountMode: trade.account_mode,
    direction: trade.direction,
    outcomeClass,
    realizedR: realizedR === null ? null : round(realizedR),
    opportunityR: opportunityR === null ? null : round(opportunityR),
    peakOptionReturnPct: readPeakOptionReturnPct(trade),
    exitReason: trade.latest_exit?.exit_reason ?? null,
    actions: readManagementActions(trade),
  };
}

function buildSymbolSummary(symbol: string, trades: LearningOutcomeTradeAudit[]): LearningOutcomeSymbolAudit {
  const realizedTrades = trades.filter((trade) => trade.realizedR !== null);
  const realizedRValues = realizedTrades.map((trade) => trade.realizedR as number);
  const opportunityRValues = realizedTrades
    .map((trade) => trade.opportunityR)
    .filter((value): value is number => value !== null);
  const classificationCounts = emptyClassCounts();
  for (const trade of trades) {
    classificationCounts[trade.outcomeClass] += 1;
  }
  const totalRealizedR = round(realizedRValues.reduce((sum, value) => sum + value, 0));
  const totalOpportunityR = round(opportunityRValues.reduce((sum, value) => sum + value, 0));
  const winnerCount = realizedTrades.filter((trade) => (trade.realizedR ?? 0) > 0).length;
  const loserCount = realizedTrades.filter((trade) => (trade.realizedR ?? 0) < 0).length;

  return {
    symbol,
    tradeCount: trades.length,
    realizedRCount: realizedTrades.length,
    winnerCount,
    loserCount,
    winRate: realizedTrades.length > 0 ? round(winnerCount / realizedTrades.length) : null,
    totalRealizedR,
    totalOpportunityR,
    averageRealizedR: realizedTrades.length > 0 ? round(totalRealizedR / realizedTrades.length) : null,
    averageOpportunityR: opportunityRValues.length > 0 ? round(totalOpportunityR / opportunityRValues.length) : null,
    bestOpportunityR: opportunityRValues.length > 0 ? round(Math.max(...opportunityRValues)) : null,
    worstRealizedR: realizedRValues.length > 0 ? round(Math.min(...realizedRValues)) : null,
    classificationCounts,
  };
}

export function buildLearningOutcomeAudit(
  trades: JournalTradeDetail[],
  options: {
    accountMode?: AccountMode | "all";
    dataWarnings?: string[];
    tradeLimit?: number;
    worstSymbolLimit?: number;
  } = {},
): LearningOutcomeAudit {
  const accountMode = options.accountMode ?? "all";
  const closedTrades = trades.filter((trade) => isLearningTrade(trade, accountMode));
  const tradeClassifications = closedTrades.map(buildTradeAudit);
  const classificationCounts = emptyClassCounts();
  for (const trade of tradeClassifications) {
    classificationCounts[trade.outcomeClass] += 1;
  }
  const realizedTrades = tradeClassifications.filter((trade) => trade.realizedR !== null);
  const totalRealizedR = round(
    realizedTrades.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0),
  );
  const totalOpportunityR = round(
    realizedTrades.reduce((sum, trade) => sum + (trade.opportunityR ?? 0), 0),
  );
  const bySymbol = [...new Set(tradeClassifications.map((trade) => trade.symbol))]
    .map((symbol) => buildSymbolSummary(
      symbol,
      tradeClassifications.filter((trade) => trade.symbol === symbol),
    ))
    .sort((left, right) => {
      if (left.realizedRCount !== right.realizedRCount) {
        return right.realizedRCount - left.realizedRCount;
      }
      return left.totalOpportunityR - right.totalOpportunityR;
    });
  const worstSymbols = [...bySymbol]
    .filter((symbol) => symbol.realizedRCount > 0)
    .sort((left, right) => {
      const opportunityDelta = left.totalOpportunityR - right.totalOpportunityR;
      return opportunityDelta !== 0
        ? opportunityDelta
        : left.totalRealizedR - right.totalRealizedR;
    })
    .slice(0, options.worstSymbolLimit ?? 8);
  const missingRealizedRTrades = tradeClassifications
    .filter((trade) => trade.outcomeClass === "missing_realized_r")
    .slice(0, options.tradeLimit ?? 25);
  const dataWarnings = [...(options.dataWarnings ?? [])];
  if (missingRealizedRTrades.length > 0) {
    dataWarnings.push(
      `${classificationCounts.missing_realized_r} closed learning trade(s) are missing realized R and are skipped by entry training until repaired.`,
    );
  }

  return {
    accountMode,
    tradeCount: trades.length,
    closedTradeCount: closedTrades.length,
    realizedRCount: realizedTrades.length,
    missingRealizedRCount: classificationCounts.missing_realized_r,
    totalRealizedR,
    totalOpportunityR,
    classificationCounts,
    bySymbol,
    worstSymbols,
    missingRealizedRTrades,
    tradeClassifications: tradeClassifications.slice(0, options.tradeLimit ?? 100),
    dataWarnings,
  };
}
