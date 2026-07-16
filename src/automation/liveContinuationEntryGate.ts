import type { AccountMode } from "../journal/types.js";
import type {
  EntryChartLearningContext,
  EntryPolicyRecommendation,
  EntryRewardFeatureInput,
} from "./entryRewardModel.js";

const LIVE_CONTINUATION_MIN_SCORE = 3;
const LIVE_CONTINUATION_VOLUME_RATIO_MIN = 0.85;
const LIVE_CONTINUATION_EXTENDED_MOVE_PCT = 16;
const LIVE_CONTINUATION_EXTENDED_RR_MAX = 2;

export type LiveContinuationEntryGateResult = {
  allowed: boolean;
  applied: boolean;
  reason: string | null;
  score: number | null;
  checks: {
    cleanImpulseHold: boolean;
    volumeConfirmed: boolean;
    rangeExpansionOk: boolean;
    trapClean: boolean;
  } | null;
};

export function evaluateLiveContinuationEntryGate(params: {
  accountMode: AccountMode;
  symbol: string | null | undefined;
  entryPolicy: EntryPolicyRecommendation;
  entryFeatures: EntryRewardFeatureInput;
  scanReason?: string | null;
}): LiveContinuationEntryGateResult {
  if (
    params.accountMode !== "live" ||
    !params.entryFeatures.setupType.toLowerCase().endsWith("_continuation")
  ) {
    return {
      allowed: true,
      applied: false,
      reason: null,
      score: null,
      checks: null,
    };
  }

  const chartContext = params.entryFeatures.chartContext ?? null;
  const reasonText = params.scanReason ?? "";
  const checks = {
    cleanImpulseHold: readCleanImpulseHold(chartContext, reasonText),
    volumeConfirmed: readVolumeConfirmed(
      chartContext,
      params.entryFeatures.volumeRatio,
      reasonText,
    ),
    rangeExpansionOk: readRangeExpansionOk(chartContext, reasonText),
    trapClean: readTrapClean(chartContext, reasonText),
  };
  const score = Object.values(checks).filter(Boolean).length;
  const extendedWithoutCleanHold =
    !checks.cleanImpulseHold &&
    isExtendedMove(chartContext?.movePct) &&
    isSubTwoChartRewardRisk(chartContext, params.entryFeatures.plannedRewardRisk);

  const shouldBlock =
    params.entryPolicy.decision === "caution" ||
    score < LIVE_CONTINUATION_MIN_SCORE ||
    extendedWithoutCleanHold;

  if (!shouldBlock) {
    return {
      allowed: true,
      applied: true,
      reason: null,
      score,
      checks,
    };
  }

  return {
    allowed: false,
    applied: true,
    reason: buildBlockReason({
      symbol: params.symbol,
      score,
      checks,
      policyDecision: params.entryPolicy.decision,
      extendedWithoutCleanHold,
      movePct: chartContext?.movePct ?? null,
      chartRewardRisk:
        chartContext?.postConfirmationRewardRisk ??
        chartContext?.preReviewRewardRisk ??
        params.entryFeatures.plannedRewardRisk ??
        null,
    }),
    score,
    checks,
  };
}

function readCleanImpulseHold(
  chartContext: EntryChartLearningContext | null,
  reasonText: string,
): boolean {
  if (hasFailedCheck(chartContext, "impulse_consolidation")) {
    return false;
  }
  const normalizedReason = normalizeText(reasonText);
  return !(
    normalizedReason.includes("impulse plus consolidation structure is not clean enough") ||
    normalizedReason.includes("impulse hold weak") ||
    normalizedReason.includes("impulse/hold weak")
  );
}

function readVolumeConfirmed(
  chartContext: EntryChartLearningContext | null,
  volumeRatio: number | null,
  reasonText: string,
): boolean {
  if (hasFailedCheck(chartContext, "volume")) {
    return false;
  }
  if (typeof volumeRatio === "number" && Number.isFinite(volumeRatio)) {
    return volumeRatio >= LIVE_CONTINUATION_VOLUME_RATIO_MIN;
  }
  const normalizedReason = normalizeText(reasonText);
  return !(
    normalizedReason.includes("volume confirmation is limited") ||
    normalizedReason.includes("limited volume") ||
    normalizedReason.includes("volume caution")
  );
}

function readRangeExpansionOk(
  chartContext: EntryChartLearningContext | null,
  reasonText: string,
): boolean {
  if (hasFailedCheck(chartContext, "expansion")) {
    return false;
  }
  if (chartContext?.expansion) {
    return !isFailedState(chartContext.expansion);
  }
  const normalizedReason = normalizeText(reasonText);
  return !(
    normalizedReason.includes("range expansion is weaker than ideal") ||
    normalizedReason.includes("weak range expansion")
  );
}

function readTrapClean(
  chartContext: EntryChartLearningContext | null,
  reasonText: string,
): boolean {
  if (
    hasFailedCheck(chartContext, "fake_hold_distribution") ||
    hasFailedCheck(chartContext, "failed_breakout_trap")
  ) {
    return false;
  }
  const normalizedReason = normalizeText(reasonText);
  return !(
    normalizedReason.includes("trap behavior is elevated") ||
    normalizedReason.includes("distribution is elevated") ||
    normalizedReason.includes("distribution plus weak hold") ||
    normalizedReason.includes("failed breakout trap") ||
    normalizedReason.includes("trap-risk present")
  );
}

function isExtendedMove(movePct: number | null | undefined): boolean {
  return typeof movePct === "number" &&
    Number.isFinite(movePct) &&
    Math.abs(movePct) >= LIVE_CONTINUATION_EXTENDED_MOVE_PCT;
}

function isSubTwoChartRewardRisk(
  chartContext: EntryChartLearningContext | null,
  plannedRewardRisk: number | null,
): boolean {
  const rewardRisk =
    chartContext?.postConfirmationRewardRisk ??
    chartContext?.preReviewRewardRisk ??
    plannedRewardRisk;
  return typeof rewardRisk === "number" &&
    Number.isFinite(rewardRisk) &&
    rewardRisk < LIVE_CONTINUATION_EXTENDED_RR_MAX;
}

function buildBlockReason(params: {
  symbol: string | null | undefined;
  score: number;
  checks: NonNullable<LiveContinuationEntryGateResult["checks"]>;
  policyDecision: EntryPolicyRecommendation["decision"];
  extendedWithoutCleanHold: boolean;
  movePct: number | null;
  chartRewardRisk: number | null;
}): string {
  const weaknessLabels = [
    params.checks.cleanImpulseHold ? null : "weak impulse/hold",
    params.checks.volumeConfirmed ? null : "light volume",
    params.checks.rangeExpansionOk ? null : "weak expansion",
    params.checks.trapClean ? null : "trap/distribution risk",
  ].filter((item): item is string => item !== null);
  const symbol = params.symbol ?? "candidate";
  const weaknessText = weaknessLabels.length > 0
    ? `; ${weaknessLabels.join(", ")}`
    : "";
  const reasonParts: string[] = [];
  if (params.policyDecision === "caution") {
    reasonParts.push("policy caution");
  }
  if (params.score < LIVE_CONTINUATION_MIN_SCORE) {
    reasonParts.push(`continuation score below ${LIVE_CONTINUATION_MIN_SCORE}`);
  }
  if (params.extendedWithoutCleanHold) {
    reasonParts.push(
      `extended move ${formatNumber(params.movePct)}% with chart R/R ${formatNumber(params.chartRewardRisk)} and weak impulse/hold`,
    );
  }

  return `Live continuation gate blocked ${symbol}: score ${params.score}/4${weaknessText}; ${reasonParts.join("; ")}.`;
}

function hasFailedCheck(
  chartContext: EntryChartLearningContext | null,
  check: string,
): boolean {
  return chartContext?.failedChecks.some((item) => normalizeCheckName(item) === check) ?? false;
}

function isFailedState(state: string): boolean {
  return normalizeText(state).startsWith("fail");
}

function normalizeCheckName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function formatNumber(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2)
    : "n/a";
}
