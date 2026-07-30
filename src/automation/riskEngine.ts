import type { TradeDirection } from "../journal/types.js";
import type { PaperTraderRiskLimits } from "./config.js";

export type PortfolioRiskPosition = {
  symbol: string;
  direction: TradeDirection | null;
  premiumExposureUsd: number | null;
  plannedRiskUsd: number | null;
  linkedJournalTradeId: string | null;
};

export type PortfolioRiskCandidate = {
  symbol: string;
  direction: TradeDirection;
  premiumCostUsd: number;
  plannedRiskUsd: number;
};

export type PortfolioRiskSnapshot = {
  accountValueUsd: number | null;
  startOfDayAccountValueUsd: number | null;
  openPremiumUsd: number;
  openPlannedRiskUsd: number;
  openPositionCount: number;
  entriesToday: number;
  dailyPlUsd: number | null;
  positionPremiumLimitUsd: number | null;
  positionPlannedRiskLimitUsd: number | null;
  aggregatePremiumLimitUsd: number | null;
  aggregatePlannedRiskLimitUsd: number | null;
  dailyLossLimitUsd: number | null;
};

export type PortfolioEntryGuardResult = {
  allowed: boolean;
  blockReasons: string[];
  snapshot: PortfolioRiskSnapshot;
};

function finiteNonNegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function sumKnown(
  positions: PortfolioRiskPosition[],
  field: "premiumExposureUsd" | "plannedRiskUsd",
): number {
  return positions.reduce((total, position) => {
    const value = position[field];
    return total + (finiteNonNegative(value) ? value : 0);
  }, 0);
}

function buildSnapshot(params: {
  accountValueUsd: number | null;
  startOfDayAccountValueUsd: number | null;
  realizedTodayUsd: number | null;
  openUnrealizedUsd: number | null;
  entriesToday: number;
  positions: PortfolioRiskPosition[];
  limits: PaperTraderRiskLimits;
}): PortfolioRiskSnapshot {
  const accountValue = params.accountValueUsd;
  const startOfDayAccountValue = params.startOfDayAccountValueUsd;
  return {
    accountValueUsd: accountValue,
    startOfDayAccountValueUsd: startOfDayAccountValue,
    openPremiumUsd: Number(sumKnown(params.positions, "premiumExposureUsd").toFixed(2)),
    openPlannedRiskUsd: Number(sumKnown(params.positions, "plannedRiskUsd").toFixed(2)),
    openPositionCount: params.positions.length,
    entriesToday: params.entriesToday,
    dailyPlUsd:
      params.realizedTodayUsd !== null && params.openUnrealizedUsd !== null
        ? Number((params.realizedTodayUsd + params.openUnrealizedUsd).toFixed(2))
        : null,
    positionPremiumLimitUsd:
      finiteNonNegative(accountValue)
        ? Number((accountValue * params.limits.maxPositionPremiumPct).toFixed(2))
        : null,
    positionPlannedRiskLimitUsd:
      finiteNonNegative(accountValue)
        ? Number((accountValue * params.limits.maxPositionPlannedRiskPct).toFixed(2))
        : null,
    aggregatePremiumLimitUsd:
      finiteNonNegative(accountValue)
        ? Number((accountValue * params.limits.maxAggregatePremiumPct).toFixed(2))
        : null,
    aggregatePlannedRiskLimitUsd:
      finiteNonNegative(accountValue)
        ? Number((accountValue * params.limits.maxAggregatePlannedRiskPct).toFixed(2))
        : null,
    dailyLossLimitUsd:
      finiteNonNegative(startOfDayAccountValue)
        ? Number((startOfDayAccountValue * params.limits.maxDailyLossPct).toFixed(2))
        : null,
  };
}

export function evaluatePortfolioEntryGuard(params: {
  accountValueUsd: number | null;
  startOfDayAccountValueUsd: number | null;
  realizedTodayUsd: number | null;
  openUnrealizedUsd: number | null;
  entriesToday: number;
  positions: PortfolioRiskPosition[];
  candidate: PortfolioRiskCandidate | null;
  limits: PaperTraderRiskLimits;
  liveHealthAllowed: boolean;
  liveHealthReason?: string | null;
}): PortfolioEntryGuardResult {
  const snapshot = buildSnapshot(params);
  const blockReasons: string[] = [];

  if (!params.liveHealthAllowed) {
    blockReasons.push(params.liveHealthReason ?? "Live strategy health guard is blocking entries.");
  }
  if (!finiteNonNegative(params.accountValueUsd) || params.accountValueUsd <= 0) {
    blockReasons.push("Current account net liquidation is unavailable.");
  }
  if (
    !finiteNonNegative(params.startOfDayAccountValueUsd)
    || params.startOfDayAccountValueUsd <= 0
  ) {
    blockReasons.push("Start-of-day account value is unavailable.");
  }
  if (params.realizedTodayUsd === null || params.openUnrealizedUsd === null) {
    blockReasons.push("Daily realized or open unrealized P/L is unavailable.");
  }

  for (const position of params.positions) {
    if (!finiteNonNegative(position.premiumExposureUsd)) {
      blockReasons.push(`Premium exposure is unavailable for ${position.symbol}.`);
    }
    if (!finiteNonNegative(position.plannedRiskUsd)) {
      blockReasons.push(`Planned risk is unavailable for ${position.symbol}.`);
    }
    if (!position.linkedJournalTradeId) {
      blockReasons.push(`Broker position ${position.symbol} is not linked to a journal trade.`);
    }
  }

  if (snapshot.openPositionCount >= params.limits.maxOpenPositions) {
    blockReasons.push(`Open-position cap of ${params.limits.maxOpenPositions} has been reached.`);
  }
  if (params.entriesToday >= params.limits.maxEntriesPerDay) {
    blockReasons.push(`Daily entry cap of ${params.limits.maxEntriesPerDay} has been reached.`);
  }
  if (
    snapshot.dailyPlUsd !== null
    && snapshot.dailyLossLimitUsd !== null
    && snapshot.dailyPlUsd <= -snapshot.dailyLossLimitUsd
  ) {
    blockReasons.push(
      `Daily P/L ${snapshot.dailyPlUsd.toFixed(2)} reached the -${snapshot.dailyLossLimitUsd.toFixed(2)} loss limit.`,
    );
  }

  const candidate = params.candidate;
  if (candidate) {
    if (
      !Number.isFinite(candidate.premiumCostUsd)
      || candidate.premiumCostUsd <= 0
      || !Number.isFinite(candidate.plannedRiskUsd)
      || candidate.plannedRiskUsd <= 0
    ) {
      blockReasons.push("Candidate premium cost or planned risk is unavailable.");
    }
    if (params.positions.some((position) => position.symbol === candidate.symbol)) {
      blockReasons.push(`A position in ${candidate.symbol} is already open.`);
    }
    const sameDirectionCount = params.positions.filter(
      (position) => position.direction === candidate.direction,
    ).length;
    if (sameDirectionCount >= params.limits.maxOpenPositionsPerDirection) {
      blockReasons.push(
        `${candidate.direction} position cap of ${params.limits.maxOpenPositionsPerDirection} has been reached.`,
      );
    }
    if (
      snapshot.positionPremiumLimitUsd !== null
      && candidate.premiumCostUsd > snapshot.positionPremiumLimitUsd
    ) {
      blockReasons.push(
        `Candidate premium ${candidate.premiumCostUsd.toFixed(2)} exceeds the ${snapshot.positionPremiumLimitUsd.toFixed(2)} per-position limit.`,
      );
    }
    if (
      snapshot.positionPlannedRiskLimitUsd !== null
      && candidate.plannedRiskUsd > snapshot.positionPlannedRiskLimitUsd
    ) {
      blockReasons.push(
        `Candidate planned risk ${candidate.plannedRiskUsd.toFixed(2)} exceeds the ${snapshot.positionPlannedRiskLimitUsd.toFixed(2)} per-position limit.`,
      );
    }
    if (
      snapshot.aggregatePremiumLimitUsd !== null
      && snapshot.openPremiumUsd + candidate.premiumCostUsd > snapshot.aggregatePremiumLimitUsd
    ) {
      blockReasons.push("Candidate would exceed the aggregate premium limit.");
    }
    if (
      snapshot.aggregatePlannedRiskLimitUsd !== null
      && snapshot.openPlannedRiskUsd + candidate.plannedRiskUsd > snapshot.aggregatePlannedRiskLimitUsd
    ) {
      blockReasons.push("Candidate would exceed the aggregate planned-risk limit.");
    }
  }

  return {
    allowed: blockReasons.length === 0,
    blockReasons: [...new Set(blockReasons)],
    snapshot,
  };
}

export type LiveHealthResult = {
  allowed: boolean;
  blockReasons: string[];
  rollingTradeCount: number;
  rollingProfitFactor: number | null;
  drawdownPct: number | null;
};

export function evaluateLiveHealth(params: {
  realizedPlUsd: number[];
  equityPeakUsd: number | null;
  currentEquityUsd: number | null;
  limits: PaperTraderRiskLimits;
}): LiveHealthResult {
  const recent = params.realizedPlUsd.slice(-params.limits.rollingHealthTradeCount);
  const grossProfit = recent.reduce((sum, value) => sum + Math.max(0, value), 0);
  const grossLoss = Math.abs(recent.reduce((sum, value) => sum + Math.min(0, value), 0));
  const rollingProfitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0
      ? Number.POSITIVE_INFINITY
      : null;
  const drawdownPct =
    params.equityPeakUsd !== null
    && params.equityPeakUsd > 0
    && params.currentEquityUsd !== null
      ? Math.max(0, (params.equityPeakUsd - params.currentEquityUsd) / params.equityPeakUsd)
      : null;
  const blockReasons: string[] = [];

  if (drawdownPct !== null && drawdownPct >= params.limits.maxLiveDrawdownPct) {
    blockReasons.push(
      `Live drawdown ${(drawdownPct * 100).toFixed(2)}% reached the ${(params.limits.maxLiveDrawdownPct * 100).toFixed(2)}% halt.`,
    );
  }
  if (
    recent.length >= params.limits.rollingHealthTradeCount
    && rollingProfitFactor !== null
    && rollingProfitFactor < params.limits.minRollingProfitFactor
  ) {
    blockReasons.push(
      `Rolling ${recent.length}-trade profit factor ${rollingProfitFactor.toFixed(2)} is below ${params.limits.minRollingProfitFactor.toFixed(2)}.`,
    );
  }

  return {
    allowed: blockReasons.length === 0,
    blockReasons,
    rollingTradeCount: recent.length,
    rollingProfitFactor,
    drawdownPct,
  };
}
