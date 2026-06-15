import type { ScanLearningPreference } from "../app/runScan.js";
import type {
  EntryRewardBucketSummary,
  EntryRewardModel,
} from "./entryRewardModel.js";
import type {
  LearningOutcomeAudit,
  LearningOutcomeSymbolAudit,
} from "./learningOutcomeAudit.js";

const MIN_PAPER_LEARNING_PENALTY_SAMPLE = 8;
const MIN_SYMBOL_PENALTY_SAMPLE = 3;
const MAX_SYMBOL_PENALTY_AVERAGE_OPPORTUNITY_R = -0.25;
const MAX_SYMBOL_PENALTY_WIN_RATE = 0.25;

function parseEntryRewardContextKey(key: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const part of key.split("|")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const name = part.slice(0, separatorIndex);
    const value = part.slice(separatorIndex + 1);
    if (value.length > 0) {
      parsed[name] = value;
    }
  }
  return parsed;
}

function scannerDirectionFromRewardDirection(
  direction: string | undefined,
): ScanLearningPreference["direction"] | null {
  if (direction === "CALL") {
    return "bullish";
  }
  if (direction === "PUT") {
    return "bearish";
  }
  return null;
}

function summarizeEntryRewardBuckets(
  model: EntryRewardModel,
): EntryRewardBucketSummary[] {
  return Object.entries(model.buckets)
    .filter(([, aggregate]) => aggregate.count > 0)
    .map(([key, aggregate]) => ({
      key,
      count: aggregate.count,
      averageRewardR: Number(
        (aggregate.totalRewardR / aggregate.count).toFixed(3),
      ),
      winRate: Number((aggregate.positiveCount / aggregate.count).toFixed(3)),
      symbols: aggregate.symbols.slice(-6),
    }));
}

function buildPaperLearningPreference(
  context: EntryRewardBucketSummary,
  decision: ScanLearningPreference["decision"],
): ScanLearningPreference | null {
  const parts = parseEntryRewardContextKey(context.key);
  const direction = scannerDirectionFromRewardDirection(parts.direction);
  const setupType = parts.setup;
  const dteBucket = parts.dte;
  const rewardRiskBucket = parts.rr;
  const chartScoreBucket = parts.chart;
  if (!direction || !setupType || !dteBucket || !rewardRiskBucket || !chartScoreBucket) {
    return null;
  }
  if (
    dteBucket === "unknown" ||
    rewardRiskBucket === "unknown" ||
    chartScoreBucket === "unknown"
  ) {
    return null;
  }

  const effect: NonNullable<ScanLearningPreference["effect"]> =
    decision === "prefer"
      ? "boost"
      : "penalty";
  const boundedReward = Math.max(-3, Math.min(3, context.averageRewardR));
  const scoreAdjustment =
    decision === "prefer"
      ? Number(Math.max(1, boundedReward).toFixed(2))
      : Number(Math.min(-1, boundedReward).toFixed(2));
  const preference: ScanLearningPreference = {
    direction,
    setupType,
    dteBucket,
    rewardRiskBucket,
    chartScoreBucket,
    decision,
    effect,
    scoreAdjustment,
    reason: `${decision === "avoid" ? "Weak" : "Rewarded"} paper setup context ${context.key}: avg ${context.averageRewardR.toFixed(2)}R over ${context.count} trade(s).`,
    sampleSize: context.count,
    averageRewardR: context.averageRewardR,
    winRate: context.winRate,
  };

  if (parts.volume && parts.volume !== "unknown") {
    preference.volumeBucket = parts.volume;
  }
  if (parts.expansion && parts.expansion !== "unknown") {
    preference.expansionBucket = parts.expansion;
  }
  if (parts.body_wick && parts.body_wick !== "unknown") {
    preference.bodyWickBucket = parts.body_wick;
  }
  if (parts.chop && parts.chop !== "unknown") {
    preference.chopBucket = parts.chop;
  }
  if (parts.continuation && parts.continuation !== "unknown") {
    preference.continuationBucket = parts.continuation;
  }
  if (parts.pullback_body && parts.pullback_body !== "unknown") {
    preference.pullbackBodyBucket = parts.pullback_body;
  }
  if (parts.pullback_volume && parts.pullback_volume !== "unknown") {
    preference.pullbackVolumeBucket = parts.pullback_volume;
  }
  if (parts.trigger_zone && parts.trigger_zone !== "unknown") {
    preference.triggerZoneBucket = parts.trigger_zone;
  }
  if (parts.failed_checks && parts.failed_checks !== "unknown") {
    preference.failedCheckBucket = parts.failed_checks;
  }
  if (parts.spread && parts.spread !== "unknown") {
    preference.optionSpreadBucket = parts.spread;
  }
  if (parts.tier && parts.tier !== "unknown") {
    preference.scanTierBucket = parts.tier;
  }
  if (parts.regime && parts.regime !== "unknown") {
    preference.marketRegimeBucket = parts.regime;
  }

  return preference;
}

export function buildPaperLearningPreferences(
  model: EntryRewardModel,
  learningAudit?: LearningOutcomeAudit | null,
): ScanLearningPreference[] {
  const contexts = summarizeEntryRewardBuckets(model);
  const avoided = contexts
    .filter((context) =>
      context.count >= MIN_PAPER_LEARNING_PENALTY_SAMPLE
      && context.averageRewardR < 0
    )
    .sort((left, right) => left.averageRewardR - right.averageRewardR);
  const preferred = contexts
    .filter((context) =>
      context.count >= MIN_PAPER_LEARNING_PENALTY_SAMPLE
      && context.averageRewardR >= 0.75
      && context.winRate >= 0.5
    )
    .sort((left, right) => right.averageRewardR - left.averageRewardR);
  const preferences = [
    ...avoided,
    ...preferred,
  ]
    .map((context) =>
      buildPaperLearningPreference(
        context,
        context.averageRewardR < 0 ? "avoid" : "prefer",
      )
    )
    .filter((preference): preference is ScanLearningPreference =>
      preference !== null
    );
  preferences.push(...buildSymbolLearningPenaltyPreferences(learningAudit));
  const seen = new Set<string>();

  return preferences.filter((preference) => {
    const key = [
      preference.symbol ?? "",
      preference.direction,
      preference.setupType,
      preference.dteBucket,
      preference.rewardRiskBucket,
      preference.chartScoreBucket,
      preference.volumeBucket ?? "",
      preference.expansionBucket ?? "",
      preference.bodyWickBucket ?? "",
      preference.chopBucket ?? "",
      preference.continuationBucket ?? "",
      preference.pullbackBodyBucket ?? "",
      preference.pullbackVolumeBucket ?? "",
      preference.triggerZoneBucket ?? "",
      preference.failedCheckBucket ?? "",
      preference.optionSpreadBucket ?? "",
      preference.scanTierBucket ?? "",
      preference.marketRegimeBucket ?? "",
      preference.decision,
    ].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function shouldPenalizeSymbol(symbol: LearningOutcomeSymbolAudit): boolean {
  return (
    symbol.realizedRCount >= MIN_SYMBOL_PENALTY_SAMPLE &&
    (symbol.averageOpportunityR ?? Number.POSITIVE_INFINITY) <= MAX_SYMBOL_PENALTY_AVERAGE_OPPORTUNITY_R &&
    (symbol.winRate ?? 1) <= MAX_SYMBOL_PENALTY_WIN_RATE
  );
}

function buildSymbolPenaltyPreference(symbol: LearningOutcomeSymbolAudit): ScanLearningPreference {
  const averageOpportunityR = symbol.averageOpportunityR ?? -1;
  const boundedPenalty = Math.max(-3, Math.min(-1, averageOpportunityR));
  return {
    symbol: symbol.symbol,
    direction: "bullish",
    setupType: "symbol_weak_history",
    dteBucket: "symbol",
    rewardRiskBucket: "symbol",
    chartScoreBucket: "symbol",
    decision: "avoid",
    effect: "penalty",
    scoreAdjustment: Number(boundedPenalty.toFixed(2)),
    reason: `Weak symbol history for ${symbol.symbol}: avg opportunity ${averageOpportunityR.toFixed(2)}R over ${symbol.realizedRCount} closed current-epoch trade(s), win rate ${(((symbol.winRate ?? 0) * 100)).toFixed(0)}%.`,
    sampleSize: symbol.realizedRCount,
    averageRewardR: averageOpportunityR,
    ...(symbol.winRate !== null ? { winRate: symbol.winRate } : {}),
  };
}

export function buildSymbolLearningPenaltyPreferences(
  learningAudit?: LearningOutcomeAudit | null,
): ScanLearningPreference[] {
  if (!learningAudit) {
    return [];
  }

  return learningAudit.bySymbol
    .filter(shouldPenalizeSymbol)
    .map(buildSymbolPenaltyPreference);
}
