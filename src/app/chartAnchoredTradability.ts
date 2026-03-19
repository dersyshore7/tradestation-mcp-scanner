import { type ScanDirection } from "../scanner/scoring.js";

export const PREFERRED_RISK_REWARD_RATIO = 2;
export const MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO = 1.5;
export const MINIMUM_TRADABLE_RISK_REWARD_RATIO = 1.25;
export type RiskRewardTier = "preferred_2r_or_better" | "acceptable_sub2r" | "borderline_tight" | "obvious_no_room";

export const CHART_ANCHORED_TWO_TO_ONE_FAILURE = "Chart-anchored levels do not support minimum tradable asymmetry";

export type ChartAnchoredTradabilitySuccess = {
  pass: true;
  invalidationUnderlying: number;
  targetUnderlying: number;
  invalidationReason: string;
  targetReason: string;
  riskDistance: number;
  rewardDistance: number;
  rewardRiskRatio: number;
  rrTier: RiskRewardTier;
  preferred2R: boolean;
  minimumConfirmableRR: number;
};

export type ChartAnchoredTradabilityFailure = {
  pass: false;
  reason: string;
  rewardRiskRatio: number | null;
  rrTier: RiskRewardTier | "unknown";
  preferred2R: boolean;
  minimumConfirmableRR: number;
};

export type ChartAnchoredTradabilityResult = ChartAnchoredTradabilitySuccess | ChartAnchoredTradabilityFailure;

export function getRiskRewardTier(rewardRiskRatio: number | null): RiskRewardTier | "unknown" {
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

  return bars.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

function readNumber(source: Record<string, unknown> | null, keys: string[]): number | null {
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

export async function evaluateChartAnchoredTradability(
  get: (path: string) => Promise<Response>,
  symbol: string,
  direction: ScanDirection,
  referencePrice: number,
): Promise<ChartAnchoredTradabilityResult> {
  const [dailyResponse, threeMonthResponse, oneYearResponse] = await Promise.all([
    get(`/marketdata/barcharts/${encodeURIComponent(symbol)}?interval=1&unit=Daily&barsback=30`),
    get(`/marketdata/barcharts/${encodeURIComponent(symbol)}?interval=1&unit=Daily&barsback=160`),
    get(`/marketdata/barcharts/${encodeURIComponent(symbol)}?interval=1&unit=Weekly&barsback=60`),
  ]);

  if (!dailyResponse.ok || !threeMonthResponse.ok || !oneYearResponse.ok) {
    return { pass: false, reason: `Unable to load chart bars to derive chart-anchored exits for ${symbol}.`, rewardRiskRatio: null, rrTier: "unknown", preferred2R: false, minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO };
  }

  const dailyBars = parseBars(await dailyResponse.json());
  const bars3M = parseBars(await threeMonthResponse.json());
  const bars1Y = parseBars(await oneYearResponse.json());

  const recentBars = dailyBars.slice(-6);
  const recentLows = recentBars.map((bar) => readNumber(bar, ["Low"])).filter((value): value is number => value !== null);
  const recentHighs = recentBars.map((bar) => readNumber(bar, ["High"])).filter((value): value is number => value !== null);

  const highs3M = bars3M.map((bar) => readNumber(bar, ["High"])).filter((value): value is number => value !== null);
  const highs1Y = bars1Y.map((bar) => readNumber(bar, ["High"])).filter((value): value is number => value !== null);
  const lows3M = bars3M.map((bar) => readNumber(bar, ["Low"])).filter((value): value is number => value !== null);
  const lows1Y = bars1Y.map((bar) => readNumber(bar, ["Low"])).filter((value): value is number => value !== null);

  if (direction === "bullish") {
    const invalidationUnderlying = recentLows.length > 0 ? Math.min(...recentLows) : null;
    const resistanceCandidates = [...highs3M, ...highs1Y].filter((value) => value > referencePrice);
    const targetUnderlying = resistanceCandidates.length > 0 ? Math.min(...resistanceCandidates) : null;

    if (invalidationUnderlying === null || targetUnderlying === null || !(invalidationUnderlying < referencePrice && targetUnderlying > referencePrice)) {
      return { pass: false, reason: `Could not derive clean bullish chart-anchored invalidation/target levels for ${symbol}.`, rewardRiskRatio: null, rrTier: "unknown", preferred2R: false, minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO };
    }

    const riskDistance = referencePrice - invalidationUnderlying;
    const rewardDistance = targetUnderlying - referencePrice;
    const rewardRiskRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;
    const rrTier = getRiskRewardTier(rewardRiskRatio) as RiskRewardTier;
    if (riskDistance <= 0 || rewardRiskRatio < MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO) {
      return { pass: false, reason: `${CHART_ANCHORED_TWO_TO_ONE_FAILURE} for ${symbol} (actual R:R ${rewardRiskRatio.toFixed(2)}; tier=${rrTier}; minimum confirmable ${MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO.toFixed(2)}).`, rewardRiskRatio, rrTier, preferred2R: rewardRiskRatio >= PREFERRED_RISK_REWARD_RATIO, minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO };
    }

    return {
      pass: true,
      invalidationUnderlying,
      targetUnderlying,
      invalidationReason: `recent daily support low (${invalidationUnderlying.toFixed(2)})`,
      targetReason: `nearest overhead resistance from 3M/1Y highs (${targetUnderlying.toFixed(2)})`,
      riskDistance,
      rewardDistance,
      rewardRiskRatio,
      rrTier,
      preferred2R: rewardRiskRatio >= PREFERRED_RISK_REWARD_RATIO,
      minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO,
    };
  }

  const invalidationUnderlying = recentHighs.length > 0 ? Math.max(...recentHighs) : null;
  const supportCandidates = [...lows3M, ...lows1Y].filter((value) => value < referencePrice);
  const targetUnderlying = supportCandidates.length > 0 ? Math.max(...supportCandidates) : null;

  if (invalidationUnderlying === null || targetUnderlying === null || !(invalidationUnderlying > referencePrice && targetUnderlying < referencePrice)) {
    return { pass: false, reason: `Could not derive clean bearish chart-anchored invalidation/target levels for ${symbol}.`, rewardRiskRatio: null, rrTier: "unknown", preferred2R: false, minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO };
  }

  const riskDistance = invalidationUnderlying - referencePrice;
  const rewardDistance = referencePrice - targetUnderlying;
  const rewardRiskRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;
  const rrTier = getRiskRewardTier(rewardRiskRatio) as RiskRewardTier;
  if (riskDistance <= 0 || rewardRiskRatio < MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO) {
    return { pass: false, reason: `${CHART_ANCHORED_TWO_TO_ONE_FAILURE} for ${symbol} (actual R:R ${rewardRiskRatio.toFixed(2)}; tier=${rrTier}; minimum confirmable ${MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO.toFixed(2)}).`, rewardRiskRatio, rrTier, preferred2R: rewardRiskRatio >= PREFERRED_RISK_REWARD_RATIO, minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO };
  }

  return {
    pass: true,
    invalidationUnderlying,
    targetUnderlying,
    invalidationReason: `recent daily resistance high (${invalidationUnderlying.toFixed(2)})`,
    targetReason: `nearest downside support from 3M/1Y lows (${targetUnderlying.toFixed(2)})`,
    riskDistance,
    rewardDistance,
    rewardRiskRatio,
    rrTier,
    preferred2R: rewardRiskRatio >= PREFERRED_RISK_REWARD_RATIO,
    minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO,
  };
}
