import type { JournalTradeDetail, TradeDirection } from "../journal/types.js";

export type PolicyAction = "hold" | "update_levels" | "exit_now";

const POLICY_REWARD_R_CAP = 5;
const MAX_USABLE_REWARD_R = 25;

type PaperTraderManagementHistoryEntry = {
  action?: unknown;
  progressToTargetPct?: unknown;
  optionReturnPct?: unknown;
};

type PolicyFeatureBuckets = {
  direction: TradeDirection;
  setupType: string;
  confidenceBucket: string;
  progressBucket: string;
  optionReturnBucket: string;
  dteBucket: string;
};

export type PolicyFeatureInput = {
  direction: TradeDirection;
  setupType: string;
  confidenceBucket: string | null;
  progressToTargetPct: number | null;
  optionReturnPct: number | null;
  dteAtEntry: number | null;
};

type PolicyExperience = {
  action: PolicyAction;
  rewardR: number;
  buckets: PolicyFeatureBuckets;
};

type PolicyAggregate = {
  count: number;
  totalRewardR: number;
  positiveCount: number;
};

type PolicyBucketSummary = {
  count: number;
  averageRewardR: number;
  winRate: number;
};

export type PolicyActionSummary = Record<PolicyAction, PolicyBucketSummary | null>;

export type LearnedPolicyModel = {
  generatedAt: string;
  closedTradeCount: number;
  experienceCount: number;
  buckets: Record<string, Partial<Record<PolicyAction, PolicyAggregate>>>;
};

export type PolicyRecommendation = {
  recommendedAction: PolicyAction | null;
  matchedKey: string | null;
  sampleSize: number;
  actionSummaries: PolicyActionSummary;
  summary: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | null {
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readManagementHistory(trade: JournalTradeDetail): PaperTraderManagementHistoryEntry[] {
  const snapshot = asRecord(trade.signal_snapshot_json);
  const automation = asRecord(snapshot?.automation);
  const paperTrader = asRecord(automation?.paperTrader);
  const managementHistory = paperTrader?.managementHistory;

  return Array.isArray(managementHistory)
    ? managementHistory.filter((item): item is PaperTraderManagementHistoryEntry =>
        !!item && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}

function bucketProgress(progressToTargetPct: number | null): string {
  if (progressToTargetPct === null) {
    return "unknown";
  }
  if (progressToTargetPct < 0) {
    return "below_entry";
  }
  if (progressToTargetPct < 25) {
    return "0_25";
  }
  if (progressToTargetPct < 50) {
    return "25_50";
  }
  if (progressToTargetPct < 80) {
    return "50_80";
  }
  if (progressToTargetPct < 100) {
    return "80_100";
  }
  return "100_plus";
}

function bucketOptionReturn(optionReturnPct: number | null): string {
  if (optionReturnPct === null) {
    return "unknown";
  }
  if (optionReturnPct < -25) {
    return "loss_gt_25";
  }
  if (optionReturnPct < 0) {
    return "loss_0_25";
  }
  if (optionReturnPct < 25) {
    return "gain_0_25";
  }
  if (optionReturnPct < 75) {
    return "gain_25_75";
  }
  return "gain_75_plus";
}

function bucketDte(dteAtEntry: number | null): string {
  if (dteAtEntry === null) {
    return "unknown";
  }
  if (dteAtEntry <= 7) {
    return "0_7";
  }
  if (dteAtEntry <= 21) {
    return "8_21";
  }
  if (dteAtEntry <= 45) {
    return "22_45";
  }
  return "46_plus";
}

function buildFeatureBuckets(input: PolicyFeatureInput): PolicyFeatureBuckets {
  return {
    direction: input.direction,
    setupType: input.setupType,
    confidenceBucket: input.confidenceBucket ?? "unknown",
    progressBucket: bucketProgress(input.progressToTargetPct),
    optionReturnBucket: bucketOptionReturn(input.optionReturnPct),
    dteBucket: bucketDte(input.dteAtEntry),
  };
}

function buildPolicyKeys(buckets: PolicyFeatureBuckets): string[] {
  return [
    [
      `direction=${buckets.direction}`,
      `setup=${buckets.setupType}`,
      `confidence=${buckets.confidenceBucket}`,
      `progress=${buckets.progressBucket}`,
      `option_return=${buckets.optionReturnBucket}`,
      `dte=${buckets.dteBucket}`,
    ].join("|"),
    [
      `direction=${buckets.direction}`,
      `setup=${buckets.setupType}`,
      `progress=${buckets.progressBucket}`,
      `option_return=${buckets.optionReturnBucket}`,
      `dte=${buckets.dteBucket}`,
    ].join("|"),
    [
      `direction=${buckets.direction}`,
      `setup=${buckets.setupType}`,
      `progress=${buckets.progressBucket}`,
      `dte=${buckets.dteBucket}`,
    ].join("|"),
    [
      `direction=${buckets.direction}`,
      `setup=${buckets.setupType}`,
      `dte=${buckets.dteBucket}`,
    ].join("|"),
    [
      `direction=${buckets.direction}`,
      `setup=${buckets.setupType}`,
    ].join("|"),
    `direction=${buckets.direction}`,
  ];
}

function buildEmptyActionSummaries(): PolicyActionSummary {
  return {
    hold: null,
    update_levels: null,
    exit_now: null,
  };
}

function summarizeAggregate(aggregate: PolicyAggregate): PolicyBucketSummary {
  return {
    count: aggregate.count,
    averageRewardR: Number((aggregate.totalRewardR / aggregate.count).toFixed(3)),
    winRate: Number((aggregate.positiveCount / aggregate.count).toFixed(3)),
  };
}

function readAction(value: unknown): PolicyAction | null {
  return value === "hold" || value === "update_levels" || value === "exit_now"
    ? value
    : null;
}

function extractPolicyExperiences(trades: JournalTradeDetail[]): PolicyExperience[] {
  const experiences: PolicyExperience[] = [];

  for (const trade of trades) {
    if (
      trade.account_mode !== "paper"
      || trade.status !== "closed"
      || !trade.review
    ) {
      continue;
    }

    const realizedR = asFiniteNumber(trade.review.realized_r_multiple);
    if (realizedR === null || Math.abs(realizedR) > MAX_USABLE_REWARD_R) {
      continue;
    }
    const cappedRealizedR = clamp(realizedR, -POLICY_REWARD_R_CAP, POLICY_REWARD_R_CAP);

    const managementHistory = readManagementHistory(trade);
    if (managementHistory.length === 0) {
      continue;
    }

    for (const [index, item] of managementHistory.entries()) {
      const action = readAction(item.action);
      if (!action) {
        continue;
      }

      const recencyWeight = (index + 1) / managementHistory.length;
      experiences.push({
        action,
        rewardR: Number((cappedRealizedR * recencyWeight).toFixed(3)),
        buckets: buildFeatureBuckets({
          direction: trade.direction,
          setupType: trade.setup_type,
          confidenceBucket: trade.confidence_bucket,
          progressToTargetPct: asFiniteNumber(item.progressToTargetPct),
          optionReturnPct: asFiniteNumber(item.optionReturnPct),
          dteAtEntry: trade.dte_at_entry,
        }),
      });
    }
  }

  return experiences;
}

export function trainPolicyModel(trades: JournalTradeDetail[]): LearnedPolicyModel {
  const experiences = extractPolicyExperiences(trades);
  const buckets: LearnedPolicyModel["buckets"] = {};

  for (const experience of experiences) {
    for (const key of buildPolicyKeys(experience.buckets)) {
      const bucket = buckets[key] ?? {};
      const aggregate = bucket[experience.action] ?? {
        count: 0,
        totalRewardR: 0,
        positiveCount: 0,
      };
      aggregate.count += 1;
      aggregate.totalRewardR += experience.rewardR;
      if (experience.rewardR > 0) {
        aggregate.positiveCount += 1;
      }
      bucket[experience.action] = aggregate;
      buckets[key] = bucket;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    closedTradeCount: trades.filter(
      (trade) => trade.account_mode === "paper" && trade.status === "closed" && !!trade.review,
    ).length,
    experienceCount: experiences.length,
    buckets,
  };
}

export function recommendPolicyAction(
  model: LearnedPolicyModel,
  input: PolicyFeatureInput,
): PolicyRecommendation {
  const buckets = buildFeatureBuckets(input);
  const keys = buildPolicyKeys(buckets);

  for (const key of keys) {
    const bucket = model.buckets[key];
    if (!bucket) {
      continue;
    }

    const actionSummaries = buildEmptyActionSummaries();
    let sampleSize = 0;

    for (const action of ["hold", "update_levels", "exit_now"] as const) {
      const aggregate = bucket[action];
      if (!aggregate) {
        continue;
      }
      const summary = summarizeAggregate(aggregate);
      actionSummaries[action] = summary;
      sampleSize += summary.count;
    }

    const rankedActions = (["hold", "update_levels", "exit_now"] as const)
      .map((action) => ({
        action,
        summary: actionSummaries[action],
      }))
      .filter((item): item is { action: PolicyAction; summary: PolicyBucketSummary } => item.summary !== null)
      .sort((left, right) => {
        if (right.summary.averageRewardR !== left.summary.averageRewardR) {
          return right.summary.averageRewardR - left.summary.averageRewardR;
        }
        return right.summary.count - left.summary.count;
      });

    const best = rankedActions[0] ?? null;
    const recommendedAction = sampleSize >= 3 ? best?.action ?? null : null;
    const summary = rankedActions.length === 0
      ? null
      : `Matched ${sampleSize} trained experiences at ${key}. Best historical action=${best?.action ?? "n/a"} with avg ${best?.summary.averageRewardR.toFixed(2) ?? "n/a"}R and win rate ${best ? (best.summary.winRate * 100).toFixed(0) : "n/a"}%.`;

    return {
      recommendedAction,
      matchedKey: key,
      sampleSize,
      actionSummaries,
      summary: sampleSize >= 3
        ? summary
        : `${summary ?? "Matched sparse policy history."} Sample size is still sparse, so use it as a weak prior only.`,
    };
  }

  return {
    recommendedAction: null,
    matchedKey: null,
    sampleSize: 0,
    actionSummaries: buildEmptyActionSummaries(),
    summary: null,
  };
}
