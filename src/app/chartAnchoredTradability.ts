import { type ScanDirection } from "../scanner/scoring.js";
import {
  findCandidateLevels,
  selectTradeGeometryFromLevels,
  validateTradeGeometry,
  type Candle,
} from "../scanner/geometry.js";

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

function toCandles(bars: Record<string, unknown>[]): Candle[] {
  return bars
    .map((bar) => {
      const open = readNumber(bar, ["Open"]);
      return {
        high: readNumber(bar, ["High"]) ?? Number.NaN,
        low: readNumber(bar, ["Low"]) ?? Number.NaN,
        close: readNumber(bar, ["Close", "Last"]) ?? Number.NaN,
        ...(open === null ? {} : { open }),
        volume: readNumber(bar, ["TotalVolume", "Volume"]),
      };
    })
    .filter(
      (bar) =>
        Number.isFinite(bar.high) &&
        Number.isFinite(bar.low) &&
        Number.isFinite(bar.close),
    );
}

export function evaluateChartAnchoredAsymmetryFromBars(
  symbol: string,
  direction: ScanDirection,
  referencePrice: number,
  dailyBars: Record<string, unknown>[],
  bars3M: Record<string, unknown>[],
  bars1Y: Record<string, unknown>[],
): ChartAnchoredTradabilityResult {
  const candidates = findCandidateLevels({
    "1D": toCandles(dailyBars),
    "4H": toCandles(bars3M.slice(-80)),
    "1W": toCandles(bars1Y),
  });
  const selection = selectTradeGeometryFromLevels(
    direction,
    referencePrice,
    candidates,
  );
  if (!selection.geometry) {
    return {
      pass: false,
      referencePrice,
      reason: `Could not derive clean ${direction} chart-anchored invalidation/target levels for ${symbol}: ${selection.reason}`,
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

  const geometryValidation = validateTradeGeometry(
    direction,
    referencePrice,
    selection.geometry,
  );
  const invalidationUnderlying = selection.geometry.invalidation.price;
  const targetUnderlying = selection.geometry.target.price;
  const riskDistance = selection.geometry.riskDistance;
  const rewardDistance = selection.geometry.rewardDistance;
  const rewardRiskRatio = selection.geometry.rewardRiskRatio;
  const roomPct = (rewardDistance / referencePrice) * 100;
  const rrTier = selection.geometry.rrTier as RiskRewardTier;
  if (
    !geometryValidation.pass ||
    riskDistance <= 0
  ) {
    return {
      pass: false,
      referencePrice,
      reason: `${CHART_ANCHORED_TWO_TO_ONE_FAILURE} for ${symbol} (${geometryValidation.reason}; actual R:R ${rewardRiskRatio.toFixed(2)}; tier=${rrTier}; minimum confirmable ${MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO.toFixed(2)}).`,
      invalidationUnderlying,
      targetUnderlying,
      invalidationReason: selection.geometry.invalidationReason,
      targetReason: selection.geometry.targetReason,
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
    invalidationReason: selection.geometry.invalidationReason,
    targetReason: selection.geometry.targetReason,
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
