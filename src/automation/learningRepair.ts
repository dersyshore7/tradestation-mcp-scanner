import {
  calculateAggregateCloseReviewValues,
} from "../journal/repository.js";
import type { AccountMode, JournalTradeDetail } from "../journal/types.js";
import {
  filterRecordsForPaperLearning,
  readPaperLearningWindow,
  type PaperLearningWindow,
} from "./paperLearningCutoff.js";

export type LearningRepairReason =
  | "repairable"
  | "unchanged"
  | "outside_learning_epoch"
  | "account_mode_mismatch"
  | "not_closed"
  | "no_exit"
  | "missing_planned_risk"
  | "missing_entry_cost"
  | "missing_exit_price";

export type LearningReviewRepairItem = {
  tradeId: string;
  symbol: string;
  accountMode: AccountMode;
  reason: LearningRepairReason;
  currentRealizedR: number | null;
  repairedRealizedR: number | null;
  currentRealizedPlUsd: number | null;
  repairedRealizedPlUsd: number | null;
  currentReturnPct: number | null;
  repairedReturnPct: number | null;
  exitCount: number;
};

export type LearningReviewRepairPlan = {
  learningStartAt: string;
  accountMode: AccountMode | "all";
  scannedTradeCount: number;
  currentEpochTradeCount: number;
  repairableCount: number;
  unchangedCount: number;
  skippedCount: number;
  items: LearningReviewRepairItem[];
};

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

function nearlyEqual(left: number | null, right: number | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return Math.abs(left - right) < 0.005;
}

function hasUsableEntryCost(trade: JournalTradeDetail): boolean {
  const optionEntryPrice = asFiniteNumber(trade.option_entry_price);
  if (optionEntryPrice !== null && optionEntryPrice > 0) {
    return true;
  }
  const contracts = asFiniteNumber(trade.contracts);
  const positionCostUsd = asFiniteNumber(trade.position_cost_usd);
  return contracts !== null && contracts > 0 && positionCostUsd !== null && positionCostUsd > 0;
}

function hasUsableExitPrices(trade: JournalTradeDetail): boolean {
  return trade.exits.every((exit) => {
    const optionExitPrice = asFiniteNumber(exit.option_exit_price);
    return optionExitPrice !== null && optionExitPrice > 0 && exit.quantity_closed > 0;
  });
}

function buildSkippedItem(
  trade: JournalTradeDetail,
  reason: LearningRepairReason,
): LearningReviewRepairItem {
  return {
    tradeId: trade.id,
    symbol: trade.symbol,
    accountMode: trade.account_mode,
    reason,
    currentRealizedR: asFiniteNumber(trade.review?.realized_r_multiple),
    repairedRealizedR: null,
    currentRealizedPlUsd: asFiniteNumber(trade.review?.realized_pl_usd),
    repairedRealizedPlUsd: null,
    currentReturnPct: asFiniteNumber(trade.review?.realized_return_pct),
    repairedReturnPct: null,
    exitCount: trade.exits.length,
  };
}

function buildRepairItem(trade: JournalTradeDetail): LearningReviewRepairItem {
  if (trade.status !== "closed") {
    return buildSkippedItem(trade, "not_closed");
  }
  if (trade.exits.length === 0) {
    return buildSkippedItem(trade, "no_exit");
  }
  if ((asFiniteNumber(trade.planned_risk_usd) ?? 0) <= 0) {
    return buildSkippedItem(trade, "missing_planned_risk");
  }
  if (!hasUsableEntryCost(trade)) {
    return buildSkippedItem(trade, "missing_entry_cost");
  }
  if (!hasUsableExitPrices(trade)) {
    return buildSkippedItem(trade, "missing_exit_price");
  }

  const currentRealizedR = asFiniteNumber(trade.review?.realized_r_multiple);
  const currentRealizedPlUsd = asFiniteNumber(trade.review?.realized_pl_usd);
  const currentReturnPct = asFiniteNumber(trade.review?.realized_return_pct);
  const repaired = calculateAggregateCloseReviewValues(trade, trade.exits);
  const repairedRealizedR = repaired.realizedRMultiple;
  const repairedRealizedPlUsd = repaired.realizedPlUsd;
  const repairedReturnPct = repaired.realizedReturnPct;
  const changed =
    !nearlyEqual(currentRealizedR, repairedRealizedR) ||
    !nearlyEqual(currentRealizedPlUsd, repairedRealizedPlUsd) ||
    !nearlyEqual(currentReturnPct, repairedReturnPct);

  return {
    tradeId: trade.id,
    symbol: trade.symbol,
    accountMode: trade.account_mode,
    reason: changed ? "repairable" : "unchanged",
    currentRealizedR,
    repairedRealizedR,
    currentRealizedPlUsd,
    repairedRealizedPlUsd,
    currentReturnPct,
    repairedReturnPct,
    exitCount: trade.exits.length,
  };
}

export function buildLearningReviewRepairPlan(
  trades: JournalTradeDetail[],
  options: {
    accountMode?: AccountMode | "all";
    window?: PaperLearningWindow;
  } = {},
): LearningReviewRepairPlan {
  const accountMode = options.accountMode ?? "all";
  const window = options.window ?? readPaperLearningWindow();
  const currentEpochTrades = filterRecordsForPaperLearning(trades, window)
    .filter((trade) => accountMode === "all" || trade.account_mode === accountMode);
  const items = currentEpochTrades.map(buildRepairItem);
  const repairableCount = items.filter((item) => item.reason === "repairable").length;
  const unchangedCount = items.filter((item) => item.reason === "unchanged").length;

  return {
    learningStartAt: window.learningStartAt,
    accountMode,
    scannedTradeCount: trades.length,
    currentEpochTradeCount: currentEpochTrades.length,
    repairableCount,
    unchangedCount,
    skippedCount: items.length - repairableCount - unchangedCount,
    items,
  };
}
