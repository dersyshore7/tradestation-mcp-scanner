import { type ScanDirection } from "./scoring.js";

const PREFERRED_RISK_REWARD_RATIO = 2;
const MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO = 1.5;

export type RiskRewardTier =
  | "preferred_2r_or_better"
  | "acceptable_sub2r"
  | "borderline_tight"
  | "obvious_no_room";

function getRiskRewardTier(rewardRiskRatio: number | null): RiskRewardTier | "unknown" {
  if (rewardRiskRatio === null || !Number.isFinite(rewardRiskRatio)) {
    return "unknown";
  }
  if (rewardRiskRatio >= PREFERRED_RISK_REWARD_RATIO) {
    return "preferred_2r_or_better";
  }
  if (rewardRiskRatio >= MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO) {
    return "acceptable_sub2r";
  }
  if (rewardRiskRatio >= 1.25) {
    return "borderline_tight";
  }
  return "obvious_no_room";
}

export type LevelTimeframe = "1D" | "4H" | "1H" | "1W";
export type LevelSide = "support" | "resistance";
export type LevelSourceType = "swing" | "base" | "retest";
export type RejectionStrength = "weak" | "medium" | "strong";

export type Candle = {
  high: number;
  low: number;
  close: number;
  open?: number;
  volume?: number | null;
};

export type LevelCandidate = {
  side: LevelSide;
  price: number;
  timeframe: LevelTimeframe;
  sourceType: LevelSourceType;
  touchCount: number;
  rejectionStrength: RejectionStrength;
  recency: "recent" | "older";
  brokenOnClose: boolean;
  volumeReaction: "none" | "clear";
  confluenceCount: number;
  score: number;
};

export type SelectedTradeGeometry = {
  invalidation: LevelCandidate;
  target: LevelCandidate;
  riskDistance: number;
  rewardDistance: number;
  rewardRiskRatio: number;
  rrTier: RiskRewardTier | "unknown";
  preferred2R: boolean;
  minimumConfirmableRR: number;
  qualityBand: "reject" | "lower_quality" | "preferred";
  invalidationReason: string;
  targetReason: string;
};

const TIMEFRAME_WEIGHT: Record<LevelTimeframe, number> = {
  "1D": 5,
  "4H": 3,
  "1H": 2,
  "1W": 5,
};

function bandPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

function countTouches(candles: Candle[], levelPrice: number): number {
  const tolerance = Math.max(0.15, levelPrice * 0.0025);
  return candles.filter((candle) => candle.low - tolerance <= levelPrice && candle.high + tolerance >= levelPrice).length;
}

function detectRejectionStrength(candles: Candle[], levelPrice: number, side: LevelSide): RejectionStrength {
  const tolerance = Math.max(0.15, levelPrice * 0.0025);
  const recent = candles.slice(-8);
  let strongest: RejectionStrength = "weak";
  for (const candle of recent) {
    const hasTouch = candle.low - tolerance <= levelPrice && candle.high + tolerance >= levelPrice;
    if (!hasTouch) {
      continue;
    }
    const range = Math.max(0.0001, candle.high - candle.low);
    const body = Math.abs(candle.close - (candle.open ?? candle.close));
    const wickBias = side === "support" ? (Math.min(candle.close, candle.open ?? candle.close) - candle.low) / range : (candle.high - Math.max(candle.close, candle.open ?? candle.close)) / range;
    if (wickBias >= 0.45 && body / range <= 0.65) {
      return "strong";
    }
    if (wickBias >= 0.25 && strongest === "weak") {
      strongest = "medium";
    }
  }
  return strongest;
}

function detectBrokenOnClose(candles: Candle[], levelPrice: number, side: LevelSide): boolean {
  const recentCloses = candles.slice(-3).map((bar) => bar.close);
  const tolerance = Math.max(0.15, levelPrice * 0.0015);
  return recentCloses.some((close) =>
    side === "support" ? close < levelPrice - tolerance : close > levelPrice + tolerance,
  );
}

export function scoreLevel(candidate: Omit<LevelCandidate, "score">): number {
  const touchWeight = candidate.touchCount >= 3 ? 4 : candidate.touchCount === 2 ? 3 : 1;
  const rejectionWeight = candidate.rejectionStrength === "strong" ? 4 : candidate.rejectionStrength === "medium" ? 2 : 0;
  const volumeWeight = candidate.volumeReaction === "clear" ? 2 : 0;
  const recencyWeight = candidate.recency === "recent" ? 2 : 1;
  const confluenceWeight = candidate.confluenceCount >= 2 ? 2 : 0;
  const brokenPenalty = candidate.brokenOnClose ? -5 : 0;
  return TIMEFRAME_WEIGHT[candidate.timeframe] + touchWeight + rejectionWeight + volumeWeight + recencyWeight + confluenceWeight + brokenPenalty;
}

function buildCandidate(
  side: LevelSide,
  price: number,
  timeframe: LevelTimeframe,
  sourceType: LevelSourceType,
  candles: Candle[],
  recency: "recent" | "older",
): LevelCandidate {
  const touchCount = countTouches(candles, price);
  const rejectionStrength = detectRejectionStrength(candles, price, side);
  const brokenOnClose = detectBrokenOnClose(candles, price, side);
  const recentVolumes = candles.slice(-12).map((bar) => bar.volume ?? null).filter((v): v is number => v !== null && Number.isFinite(v));
  const volumeReaction = recentVolumes.length >= 4 ? "clear" : "none";
  const confluenceCount = sourceType === "base" ? 2 : 1;
  const baseCandidate: Omit<LevelCandidate, "score"> = {
    side,
    price,
    timeframe,
    sourceType,
    touchCount,
    rejectionStrength,
    recency,
    brokenOnClose,
    volumeReaction,
    confluenceCount,
  };

  return {
    ...baseCandidate,
    score: scoreLevel(baseCandidate),
  };
}

function swingCandidates(candles: Candle[], timeframe: LevelTimeframe): LevelCandidate[] {
  const levels: LevelCandidate[] = [];
  for (let i = 1; i < candles.length - 1; i += 1) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];
    if (!prev || !curr || !next) {
      continue;
    }
    if (curr.low <= prev.low && curr.low <= next.low) {
      levels.push(buildCandidate("support", bandPrice(curr.low), timeframe, "swing", candles, i > candles.length - 10 ? "recent" : "older"));
    }
    if (curr.high >= prev.high && curr.high >= next.high) {
      levels.push(buildCandidate("resistance", bandPrice(curr.high), timeframe, "swing", candles, i > candles.length - 10 ? "recent" : "older"));
    }
  }
  return levels;
}

function baseCandidates(candles: Candle[], timeframe: LevelTimeframe): LevelCandidate[] {
  if (candles.length < 6) {
    return [];
  }
  const recent = candles.slice(-8);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const ceiling = Math.max(...highs);
  const floor = Math.min(...lows);
  return [
    buildCandidate("resistance", bandPrice(ceiling), timeframe, "base", candles, "recent"),
    buildCandidate("support", bandPrice(floor), timeframe, "base", candles, "recent"),
  ];
}

function dedupeLevels(levels: LevelCandidate[]): LevelCandidate[] {
  const byKey = new Map<string, LevelCandidate>();
  for (const level of levels) {
    const key = `${level.side}:${Math.round(level.price * 100)}`;
    const existing = byKey.get(key);
    if (!existing || level.score > existing.score) {
      byKey.set(key, level);
    }
  }
  return Array.from(byKey.values());
}

export function findCandidateLevels(frames: Partial<Record<LevelTimeframe, Candle[]>>): LevelCandidate[] {
  const all: LevelCandidate[] = [];
  for (const [timeframe, candlesRaw] of Object.entries(frames) as [LevelTimeframe, Candle[] | undefined][]) {
    const candles = (candlesRaw ?? []).filter((candle) => Number.isFinite(candle.high) && Number.isFinite(candle.low) && Number.isFinite(candle.close));
    if (candles.length < 3) {
      continue;
    }
    all.push(...swingCandidates(candles, timeframe));
    all.push(...baseCandidates(candles, timeframe));
  }
  return dedupeLevels(all).sort((a, b) => b.score - a.score);
}

function isMeaningfulFirstObstacle(
  sortedDirectional: LevelCandidate[],
  idx: number,
): boolean {
  if (idx === 0) {
    return true;
  }
  const previous = sortedDirectional[idx - 1];
  const current = sortedDirectional[idx];
  if (!previous || !current) {
    return false;
  }
  return (
    previous.brokenOnClose ||
    current.score >= previous.score + 3
  );
}

function describeCandidate(candidate: LevelCandidate): string {
  return `${candidate.timeframe} ${candidate.sourceType} ${candidate.side} @ ${candidate.price.toFixed(2)} (score=${candidate.score}, touches=${candidate.touchCount}, rejection=${candidate.rejectionStrength}${candidate.brokenOnClose ? ", broken" : ""})`;
}

export function selectTradeGeometryFromLevels(
  direction: ScanDirection,
  referencePrice: number,
  candidates: LevelCandidate[],
): { geometry: SelectedTradeGeometry | null; reason: string } {
  const invalidationSide: LevelSide = direction === "bullish" ? "support" : "resistance";
  const targetSide: LevelSide = direction === "bullish" ? "resistance" : "support";

  const validInvalidations = candidates
    .filter((candidate) => candidate.side === invalidationSide)
    .filter((candidate) => direction === "bullish" ? candidate.price < referencePrice : candidate.price > referencePrice)
    .filter((candidate) => !candidate.brokenOnClose)
    .sort((a, b) => b.score - a.score);

  const directionalTargets = candidates
    .filter((candidate) => candidate.side === targetSide)
    .filter((candidate) => direction === "bullish" ? candidate.price > referencePrice : candidate.price < referencePrice)
    .sort((a, b) => (direction === "bullish" ? a.price - b.price : b.price - a.price));

  if (validInvalidations.length === 0 || directionalTargets.length === 0) {
    return { geometry: null, reason: "No validated directional invalidation/target levels were available." };
  }

  const invalidation = validInvalidations[0];
  if (!invalidation) {
    return { geometry: null, reason: "No validated invalidation level was available." };
  }
  const target = directionalTargets.find((level, idx) => isMeaningfulFirstObstacle(directionalTargets, idx));
  if (!target) {
    return { geometry: null, reason: "No meaningful first obstacle target was available." };
  }

  const riskDistance = direction === "bullish" ? referencePrice - invalidation.price : invalidation.price - referencePrice;
  const rewardDistance = direction === "bullish" ? target.price - referencePrice : referencePrice - target.price;
  const rewardRiskRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;
  const rrTier = getRiskRewardTier(rewardRiskRatio);

  const orderingPass = direction === "bullish"
    ? invalidation.price < referencePrice && referencePrice < target.price
    : target.price < referencePrice && referencePrice < invalidation.price;

  if (!orderingPass || riskDistance <= 0 || rewardDistance <= 0) {
    return { geometry: null, reason: "Hard geometry ordering guard failed." };
  }

  const qualityBand: SelectedTradeGeometry["qualityBand"] = rewardRiskRatio < MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO
    ? "reject"
    : rewardRiskRatio < PREFERRED_RISK_REWARD_RATIO
      ? "lower_quality"
      : "preferred";

  return {
    geometry: {
      invalidation,
      target,
      riskDistance,
      rewardDistance,
      rewardRiskRatio,
      rrTier,
      preferred2R: rewardRiskRatio >= PREFERRED_RISK_REWARD_RATIO,
      minimumConfirmableRR: MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO,
      qualityBand,
      invalidationReason: `invalidation from highest-scoring validated ${invalidationSide} below/above reference: ${describeCandidate(invalidation)}`,
      targetReason: `target from first meaningful validated ${targetSide} obstacle: ${describeCandidate(target)}`,
    },
    reason: "ok",
  };
}

export function validateTradeGeometry(
  direction: ScanDirection,
  referencePrice: number,
  geometry: SelectedTradeGeometry,
): { pass: boolean; reason: string } {
  const orderingPass = direction === "bullish"
    ? geometry.invalidation.price < referencePrice && referencePrice < geometry.target.price
    : geometry.target.price < referencePrice && referencePrice < geometry.invalidation.price;
  if (!orderingPass) {
    return { pass: false, reason: "Hard ordering constraint failed." };
  }

  if (geometry.rewardRiskRatio < MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO) {
    return {
      pass: false,
      reason: `First meaningful real target is below minimum confirmable R:R (${geometry.rewardRiskRatio.toFixed(2)} < ${MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO.toFixed(2)}).`,
    };
  }

  return { pass: true, reason: "Geometry is validated from independent support/resistance levels." };
}

export function validateLongPremiumOptionTranslation(
  entryPremium: number,
  premiumAtInvalidation: number,
  premiumAtTarget: number,
): { pass: boolean; reason: string } {
  if (!(premiumAtInvalidation < entryPremium)) {
    return {
      pass: false,
      reason: "Option sanity check failed: premium at invalidation must be below entry premium for long premium trades.",
    };
  }
  if (!(premiumAtTarget > entryPremium)) {
    return {
      pass: false,
      reason: "Option sanity check failed: premium at target must be above entry premium for long premium trades.",
    };
  }
  return { pass: true, reason: "Option translation sanity checks passed." };
}
