import { type ScanDirection } from "../scanner/scoring.js";

export const PREFERRED_RISK_REWARD_RATIO = 2;
export const MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO = 1.5;
export const MINIMUM_TRADABLE_RISK_REWARD_RATIO = 1.25;
export type RiskRewardTier =
  | "preferred_2r_or_better"
  | "acceptable_sub2r"
  | "borderline_tight"
  | "obvious_no_room";

export const CHART_ANCHORED_TWO_TO_ONE_FAILURE =
  "Chart-anchored levels do not support minimum tradable asymmetry";

export type ChartAnchoredTradabilitySuccess = {
  pass: true;
  referencePrice: number;
  invalidationUnderlying: number;
  targetUnderlying: number;
  invalidationReason: string;
  targetReason: string;
  riskDistance: number;
  rewardDistance: number;
  rewardRiskRatio: number;
  roomPct: number;
  rrTier: RiskRewardTier;
  preferred2R: boolean;
  minimumConfirmableRR: number;
};

export type ChartAnchoredTradabilityFailure = {
  pass: false;
  referencePrice: number;
  reason: string;
  invalidationUnderlying: number | null;
  targetUnderlying: number | null;
  invalidationReason: string | null;
  targetReason: string | null;
  riskDistance: number | null;
  rewardDistance: number | null;
  rewardRiskRatio: number | null;
  roomPct: number | null;
  rrTier: RiskRewardTier | "unknown";
  preferred2R: boolean;
  minimumConfirmableRR: number;
};

export type ChartAnchoredTradabilityResult =
  | ChartAnchoredTradabilitySuccess
  | ChartAnchoredTradabilityFailure;

export function getRiskRewardTier(
  rewardRiskRatio: number | null,
): RiskRewardTier | "unknown" {
  if (rewardRiskRatio === null || !Number.isFinite(rewardRiskRatio)) {
    return "unknown";
  }
  if (rewardRiskRatio >= PREFERRED_RISK_REWARD_RATIO) {
    return "preferred_2r_or_better";
  }
  if (rewardRiskRatio >= MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO) {
    return "acceptable_sub2r";
  }
  if (rewardRiskRatio >= MINIMUM_TRADABLE_RISK_REWARD_RATIO) {
    return "borderline_tight";
  }
  return "obvious_no_room";
}

function parseBars(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const candidate = payload as Record<string, unknown>;
  const bars = candidate["Bars"];
  if (!Array.isArray(bars)) {
    return [];
  }

  return bars.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object",
  );
}

function readNumber(
  source: Record<string, unknown> | null,
  keys: string[],
): number | null {
  if (!source) {
    return null;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim().replace(/,/g, ""));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function selectMeaningfulTargetLevel(
  direction: ScanDirection,
  referencePrice: number,
  riskDistance: number,
  candidates: number[],
): number | null {
  const directionalCandidates = candidates
    .filter((value) =>
      direction === "bullish" ? value > referencePrice : value < referencePrice,
    )
    .sort((a, b) => (direction === "bullish" ? a - b : b - a));

  if (directionalCandidates.length === 0) {
    return null;
  }

  if (!(riskDistance > 0)) {
    return directionalCandidates[0] ?? null;
  }

  const minimumMeaningfulTarget =
    direction === "bullish"
      ? referencePrice + riskDistance * MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO
      : referencePrice - riskDistance * MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO;

  const levelMeetingMinimum = directionalCandidates.find((value) =>
    direction === "bullish"
      ? value >= minimumMeaningfulTarget
      : value <= minimumMeaningfulTarget,
  );

  return levelMeetingMinimum ?? directionalCandidates[0] ?? null;
}

export function evaluateChartAnchoredAsymmetryFromBars(
  symbol: string,
  direction: ScanDirection,
  referencePrice: number,
  dailyBars: Record<string, unknown>[],
  bars3M: Record<string, unknown>[],
  bars1Y: Record<string, unknown>[],
): ChartAnchoredTradabilityResult {
  const recentBars = dailyBars.slice(-6);
  const recentLows = recentBars
    .map((bar) => readNumber(bar, ["Low"]))
    .filter((value): value is number => value !== null);
  const recentHighs = recentBars
    .map((bar) => readNumber(bar, ["High"]))
    .filter((value): value is number => value !== null);

  const highs3M = bars3M
    .map((bar) => readNumber(bar, ["High"]))
    .filter((value): value is number => value !== null);
  const highs1Y = bars1Y
    .map((bar) => readNumber(bar, ["High"]))
    .filter((value): value is number => value !== null);
  const lows3M = bars3M
    .map((bar) => readNumber(bar, ["Low"]))
    .filter((value): value is number => value !== null);
  const lows1Y = bars1Y
    .map((bar) => readNumber(bar, ["Low"]))
    .filter((value): value is number => value !== null);

  if (direction === "bullish") {
    const invalidationUnderlying =
      recentLows.length > 0 ? Math.min(...recentLows) : null;
    const resistanceCandidates = [...highs3M, ...highs1Y];
    const initialRiskDistance =
      invalidationUnderlying === null ? null : referencePrice - invalidationUnderlying;
    const targetUnderlying =
      initialRiskDistance === null
        ? selectMeaningfulTargetLevel(
            direction,
            referencePrice,
            0,
            resistanceCandidates,
          )
        : selectMeaningfulTargetLevel(
            direction,
            referencePrice,
            initialRiskDistance,
            resistanceCandidates,
          );

    if (
      invalidationUnderlying === null ||
      targetUnderlying === null ||
      !(
        invalidationUnderlying < referencePrice &&
        targetUnderlying > referencePrice
      )
    ) {
      return {
        pass: false,
        referencePrice,
        reason: `Could not derive clean bullish chart-anchored invalidation/target levels for ${symbol}.`,
        invalidationUnderlying,
        targetUnderlying,
        invalidationReason:
          invalidationUnderlying === null
            ? null
            : `recent daily support low (${invalidationUnderlying.toFixed(2)})`,
        targetReason:
          targetUnderlying === null
            ? null
            : `nearest overhead 3M/1Y resistance that still preserves practical minimum asymmetry (${targetUnderlying.toFixed(2)})`,
        riskDistance:
          invalidationUnderlying === null
            ? null
            : Math.max(0, referencePrice - invalidationUnderlying),
        rewardDistance:
          targetUnderlying === null
            ? null
            : Math.max(0, targetUnderlying - referencePrice),
        rewardRiskRatio: null,
        roomPct:
          targetUnderlying === null
            ? null
            : ((targetUnderlying - referencePrice) / referencePrice) * 100,
        rrTier: "unknown",
        preferred2R: false,
        minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO,
      };
    }

    const riskDistance = referencePrice - invalidationUnderlying;
    const rewardDistance = targetUnderlying - referencePrice;
    const rewardRiskRatio =
      riskDistance > 0 ? rewardDistance / riskDistance : 0;
    const roomPct = (rewardDistance / referencePrice) * 100;
    const rrTier = getRiskRewardTier(rewardRiskRatio) as RiskRewardTier;
    if (
      riskDistance <= 0 ||
      rewardRiskRatio < MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO
    ) {
      return {
        pass: false,
        referencePrice,
        reason: `${CHART_ANCHORED_TWO_TO_ONE_FAILURE} for ${symbol} (actual R:R ${rewardRiskRatio.toFixed(2)}; tier=${rrTier}; minimum confirmable ${MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO.toFixed(2)}).`,
        invalidationUnderlying,
        targetUnderlying,
        invalidationReason: `recent daily support low (${invalidationUnderlying.toFixed(2)})`,
        targetReason: `nearest overhead 3M/1Y resistance that still preserves practical minimum asymmetry (${targetUnderlying.toFixed(2)})`,
        riskDistance,
        rewardDistance,
        rewardRiskRatio,
        roomPct,
        rrTier,
        preferred2R: rewardRiskRatio >= PREFERRED_RISK_REWARD_RATIO,
        minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO,
      };
    }

    return {
      pass: true,
      referencePrice,
      invalidationUnderlying,
      targetUnderlying,
      invalidationReason: `recent daily support low (${invalidationUnderlying.toFixed(2)})`,
      targetReason: `nearest overhead 3M/1Y resistance that still preserves practical minimum asymmetry (${targetUnderlying.toFixed(2)})`,
      riskDistance,
      rewardDistance,
      rewardRiskRatio,
      roomPct,
      rrTier,
      preferred2R: rewardRiskRatio >= PREFERRED_RISK_REWARD_RATIO,
      minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO,
    };
  }

  const invalidationUnderlying =
    recentHighs.length > 0 ? Math.max(...recentHighs) : null;
  const supportCandidates = [...lows3M, ...lows1Y];
  const bearishRiskDistance =
    invalidationUnderlying === null ? null : invalidationUnderlying - referencePrice;
  const targetUnderlying =
    bearishRiskDistance === null
      ? selectMeaningfulTargetLevel(
          direction,
          referencePrice,
          0,
          supportCandidates,
        )
      : selectMeaningfulTargetLevel(
          direction,
          referencePrice,
          bearishRiskDistance,
          supportCandidates,
        );

  if (
    invalidationUnderlying === null ||
    targetUnderlying === null ||
    !(
      invalidationUnderlying > referencePrice &&
      targetUnderlying < referencePrice
    )
  ) {
    return {
      pass: false,
      referencePrice,
      reason: `Could not derive clean bearish chart-anchored invalidation/target levels for ${symbol}.`,
      invalidationUnderlying,
      targetUnderlying,
      invalidationReason:
        invalidationUnderlying === null
          ? null
          : `recent daily resistance high (${invalidationUnderlying.toFixed(2)})`,
      targetReason:
        targetUnderlying === null
          ? null
          : `nearest downside 3M/1Y support that still preserves practical minimum asymmetry (${targetUnderlying.toFixed(2)})`,
      riskDistance:
        invalidationUnderlying === null
          ? null
          : Math.max(0, invalidationUnderlying - referencePrice),
      rewardDistance:
        targetUnderlying === null
          ? null
          : Math.max(0, referencePrice - targetUnderlying),
      rewardRiskRatio: null,
      roomPct:
        targetUnderlying === null
          ? null
          : ((referencePrice - targetUnderlying) / referencePrice) * 100,
      rrTier: "unknown",
      preferred2R: false,
      minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO,
    };
  }

  const riskDistance = invalidationUnderlying - referencePrice;
  const rewardDistance = referencePrice - targetUnderlying;
  const rewardRiskRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;
  const roomPct = (rewardDistance / referencePrice) * 100;
  const rrTier = getRiskRewardTier(rewardRiskRatio) as RiskRewardTier;
  if (
    riskDistance <= 0 ||
    rewardRiskRatio < MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO
  ) {
    return {
      pass: false,
      referencePrice,
      reason: `${CHART_ANCHORED_TWO_TO_ONE_FAILURE} for ${symbol} (actual R:R ${rewardRiskRatio.toFixed(2)}; tier=${rrTier}; minimum confirmable ${MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO.toFixed(2)}).`,
      invalidationUnderlying,
      targetUnderlying,
      invalidationReason: `recent daily resistance high (${invalidationUnderlying.toFixed(2)})`,
      targetReason: `nearest downside 3M/1Y support that still preserves practical minimum asymmetry (${targetUnderlying.toFixed(2)})`,
      riskDistance,
      rewardDistance,
      rewardRiskRatio,
      roomPct,
      rrTier,
      preferred2R: rewardRiskRatio >= PREFERRED_RISK_REWARD_RATIO,
      minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO,
    };
  }

  return {
    pass: true,
    referencePrice,
    invalidationUnderlying,
    targetUnderlying,
    invalidationReason: `recent daily resistance high (${invalidationUnderlying.toFixed(2)})`,
    targetReason: `nearest downside 3M/1Y support that still preserves practical minimum asymmetry (${targetUnderlying.toFixed(2)})`,
    riskDistance,
    rewardDistance,
    rewardRiskRatio,
    roomPct,
    rrTier,
    preferred2R: rewardRiskRatio >= PREFERRED_RISK_REWARD_RATIO,
    minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO,
  };
}

export async function evaluateChartAnchoredTradability(
  get: (path: string) => Promise<Response>,
  symbol: string,
  direction: ScanDirection,
  referencePrice: number,
): Promise<ChartAnchoredTradabilityResult> {
  const [dailyResponse, threeMonthResponse, oneYearResponse] =
    await Promise.all([
      get(
        `/marketdata/barcharts/${encodeURIComponent(symbol)}?interval=1&unit=Daily&barsback=30`,
      ),
      get(
        `/marketdata/barcharts/${encodeURIComponent(symbol)}?interval=1&unit=Daily&barsback=160`,
      ),
      get(
        `/marketdata/barcharts/${encodeURIComponent(symbol)}?interval=1&unit=Weekly&barsback=60`,
      ),
    ]);

  if (!dailyResponse.ok || !threeMonthResponse.ok || !oneYearResponse.ok) {
    return {
      pass: false,
      referencePrice,
      reason: `Unable to load chart bars to derive chart-anchored exits for ${symbol}.`,
      invalidationUnderlying: null,
      targetUnderlying: null,
      invalidationReason: null,
      targetReason: null,
      riskDistance: null,
      rewardDistance: null,
      rewardRiskRatio: null,
      roomPct: null,
      rrTier: "unknown",
      preferred2R: false,
      minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO,
    };
  }

  return evaluateChartAnchoredAsymmetryFromBars(
    symbol,
    direction,
    referencePrice,
    parseBars(await dailyResponse.json()),
    parseBars(await threeMonthResponse.json()),
    parseBars(await oneYearResponse.json()),
  );
}
