import { evaluateChartAnchoredAsymmetryFromBars } from "../app/chartAnchoredTradability.js";
import { normalizeBar, parseBars, runSingleSymbolTradeStationAnalysis } from "../app/runScan.js";
import type { TradeDirection } from "../journal/types.js";
import { createTradeStationGetFetcher } from "../tradestation/client.js";

export type CurrentChartReviewResult = {
  conclusion: "confirmed" | "rejected" | "no_trade_today" | "unavailable";
  direction: "bullish" | "bearish" | null;
  confidence: string | null;
  confidencePercent: number | null;
  estimatedProfitChancePercent: number | null;
  reason: string;
  plainEnglishSummary: string;
  alignsWithTradeDirection: boolean | null;
  referencePrice: number | null;
  invalidationLevel: number | null;
  targetLevel: number | null;
  invalidationReason: string | null;
  targetReason: string | null;
  actualRewardRiskRatio: number | null;
  nearestSupportBelow: number | null;
  nearestResistanceAbove: number | null;
  levelSource: "scanner_confirmation" | "trade_direction_chart" | "unavailable";
  timeframes: {
    label: "1D" | "1W" | "1M" | "3M" | "1Y";
    barCount: number;
    latestClose: number | null;
    movePct: number | null;
    volumeRatio: number | null;
  }[];
  topBlockingReasons: string[];
};

export type CurrentChartReviewInput = {
  symbol: string;
  direction: TradeDirection;
  currentUnderlyingPrice: number | null;
  optionReturnPct: number | null;
  baseUrl: string;
};

function toMarketDirection(direction: TradeDirection): "bullish" | "bearish" {
  return direction === "CALL" ? "bullish" : "bearish";
}

type MarketDirection = ReturnType<typeof toMarketDirection>;
type CurrentChartReviewTimeframeLabel = CurrentChartReviewResult["timeframes"][number]["label"];
type CurrentChartReviewTimeframeBars = Record<CurrentChartReviewTimeframeLabel, Record<string, unknown>[]>;

const CHART_REVIEW_BAR_CONFIG: Record<
  CurrentChartReviewTimeframeLabel,
  { interval: number; unit: "Daily" | "Weekly"; barsBack: number }
> = {
  "1D": { interval: 1, unit: "Daily", barsBack: 20 },
  "1W": { interval: 1, unit: "Daily", barsBack: 35 },
  "1M": { interval: 1, unit: "Daily", barsBack: 80 },
  "3M": { interval: 1, unit: "Daily", barsBack: 160 },
  "1Y": { interval: 1, unit: "Weekly", barsBack: 60 },
};

function positiveNumberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Number(value.toFixed(2));
}

function readBarNumber(source: Record<string, unknown> | null | undefined, keys: string[]): number | null {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim().replace(/,/g, ""));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function computeMovePctFromBars(bars: Record<string, unknown>[]): number | null {
  const firstClose = readBarNumber(bars[0], ["Close"]);
  const lastClose = readBarNumber(bars[bars.length - 1], ["Close"]);
  if (firstClose === null || lastClose === null || firstClose <= 0) {
    return null;
  }
  return Number((((lastClose - firstClose) / firstClose) * 100).toFixed(2));
}

function computeVolumeRatioFromBars(bars: Record<string, unknown>[]): number | null {
  const latest = bars[bars.length - 1] ?? null;
  const latestVolume = readBarNumber(latest, ["TotalVolume", "Volume", "Vol", "TotalVolumeTraded"]);
  const priorVolumes = bars
    .slice(Math.max(0, bars.length - 21), -1)
    .map((bar) => readBarNumber(bar, ["TotalVolume", "Volume", "Vol", "TotalVolumeTraded"]))
    .filter((value): value is number => value !== null);

  if (latestVolume === null || priorVolumes.length === 0) {
    return null;
  }
  const averageVolume = priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length;
  return averageVolume > 0 ? Number((latestVolume / averageVolume).toFixed(2)) : null;
}

function nearestBelow(values: number[], referencePrice: number): number | null {
  const candidates = values.filter((value) => value < referencePrice);
  return candidates.length > 0 ? Number(Math.max(...candidates).toFixed(2)) : null;
}

function nearestAbove(values: number[], referencePrice: number): number | null {
  const candidates = values.filter((value) => value > referencePrice);
  return candidates.length > 0 ? Number(Math.min(...candidates).toFixed(2)) : null;
}

function computeRewardRiskRatio(params: {
  direction: MarketDirection;
  referencePrice: number | null;
  invalidationLevel: number | null;
  targetLevel: number | null;
}): number | null {
  const { direction, referencePrice, invalidationLevel, targetLevel } = params;
  if (referencePrice === null || invalidationLevel === null || targetLevel === null) {
    return null;
  }
  const riskDistance = direction === "bullish"
    ? referencePrice - invalidationLevel
    : invalidationLevel - referencePrice;
  const rewardDistance = direction === "bullish"
    ? targetLevel - referencePrice
    : referencePrice - targetLevel;
  if (!(riskDistance > 0) || !(rewardDistance > 0)) {
    return null;
  }
  return Number((rewardDistance / riskDistance).toFixed(2));
}

function midpointConfidencePercent(bucket: string | null): number | null {
  if (!bucket) {
    return null;
  }
  const match = /^(\d+)-(\d+)$/.exec(bucket);
  if (!match) {
    return null;
  }
  return Math.round((Number(match[1]) + Number(match[2])) / 2);
}

function estimateProfitChancePercent(params: {
  decisionDirection: TradeDirection;
  chartConclusion: CurrentChartReviewResult["conclusion"];
  alignsWithTradeDirection: boolean | null;
  rewardRiskRatio: number | null;
  optionReturnPct: number | null;
  timeframes: CurrentChartReviewResult["timeframes"];
}): number | null {
  let score = 48;
  if (params.chartConclusion === "confirmed") {
    score += 18;
  } else if (params.chartConclusion === "rejected") {
    score -= 14;
  } else if (params.chartConclusion === "unavailable") {
    return null;
  }

  if (params.alignsWithTradeDirection === true) {
    score += 14;
  } else if (params.alignsWithTradeDirection === false) {
    score -= 24;
  } else {
    score -= 8;
  }

  if (params.rewardRiskRatio !== null) {
    if (params.rewardRiskRatio >= 2) {
      score += 10;
    } else if (params.rewardRiskRatio >= 1.5) {
      score += 4;
    } else if (params.rewardRiskRatio < 1) {
      score -= 12;
    }
  } else {
    score -= 6;
  }

  const expectedSign = params.decisionDirection === "CALL" ? 1 : -1;
  const timeframeBias = params.timeframes.reduce((total, item) => {
    if (item.movePct === null) {
      return total;
    }
    return total + (Math.sign(item.movePct) === expectedSign ? 1 : -1);
  }, 0);
  score += timeframeBias * 3;

  if (params.optionReturnPct !== null && params.optionReturnPct < -35) {
    score -= 7;
  }

  return Math.max(5, Math.min(90, Math.round(score)));
}

async function loadCurrentChartReviewBars(
  symbol: string,
  baseUrl: string,
): Promise<CurrentChartReviewTimeframeBars> {
  const get = await createTradeStationGetFetcher(baseUrl);
  const entries = await Promise.all(
    (Object.entries(CHART_REVIEW_BAR_CONFIG) as [
      CurrentChartReviewTimeframeLabel,
      { interval: number; unit: "Daily" | "Weekly"; barsBack: number },
    ][]).map(async ([label, config]) => {
      const path = `/marketdata/barcharts/${encodeURIComponent(symbol)}?interval=${config.interval}&unit=${config.unit}&barsback=${config.barsBack}`;
      const response = await get(path);
      if (!response.ok) {
        throw new Error(`TradeStation chart request failed (${response.status}) for ${label}.`);
      }
      const bars = parseBars(await response.json()).map((bar) => normalizeBar(bar));
      return [label, bars] as const;
    }),
  );

  const barsByView = {} as CurrentChartReviewTimeframeBars;
  for (const [label, bars] of entries) {
    barsByView[label] = bars;
  }

  return barsByView;
}

function buildTimeframeReads(
  barsByView: CurrentChartReviewTimeframeBars,
): CurrentChartReviewResult["timeframes"] {
  return (Object.keys(CHART_REVIEW_BAR_CONFIG) as CurrentChartReviewTimeframeLabel[]).map((label) => {
    const bars = barsByView[label] ?? [];
    return {
      label,
      barCount: bars.length,
      latestClose: positiveNumberOrNull(readBarNumber(bars[bars.length - 1], ["Close"])),
      movePct: computeMovePctFromBars(bars),
      volumeRatio: label === "1D" ? computeVolumeRatioFromBars(bars) : null,
    };
  });
}

function buildPlainEnglishMarketRead(params: {
  input: CurrentChartReviewInput;
  conclusion: CurrentChartReviewResult["conclusion"];
  alignsWithTradeDirection: boolean | null;
  referencePrice: number | null;
  invalidationLevel: number | null;
  targetLevel: number | null;
  rewardRiskRatio: number | null;
  nearestSupportBelow: number | null;
  nearestResistanceAbove: number | null;
  timeframes: CurrentChartReviewResult["timeframes"];
  blockingReasons: string[];
}): string {
  const expectedDirection = toMarketDirection(params.input.direction);
  const timeframeText = params.timeframes
    .map((item) => `${item.label} ${item.movePct === null ? "n/a" : `${item.movePct.toFixed(2)}%`}`)
    .join(", ");
  const alignmentText = params.alignsWithTradeDirection === true
    ? `The fresh chart direction agrees with your ${params.input.direction}.`
    : params.alignsWithTradeDirection === false
      ? `The fresh chart direction is working against your ${params.input.direction}.`
      : `The scanner does not have a clean ${expectedDirection} entry setup right now.`;
  const levelText =
    params.referencePrice === null
      ? "I could not anchor levels because a current/reference price was unavailable."
      : `Using about ${params.referencePrice.toFixed(2)} as the live reference, the trade-direction invalidation area is ${params.invalidationLevel === null ? "not cleanly available" : params.invalidationLevel.toFixed(2)} and the target/support area is ${params.targetLevel === null ? "not cleanly available" : params.targetLevel.toFixed(2)}.`;
  const rrText = params.rewardRiskRatio === null
    ? "That means the reward/risk could not be confirmed cleanly."
    : `That leaves roughly ${params.rewardRiskRatio.toFixed(2)}R of chart reward/risk.`;
  const srText =
    params.nearestSupportBelow === null && params.nearestResistanceAbove === null
      ? ""
      : `Nearest visible support below is ${params.nearestSupportBelow === null ? "n/a" : params.nearestSupportBelow.toFixed(2)} and resistance above is ${params.nearestResistanceAbove === null ? "n/a" : params.nearestResistanceAbove.toFixed(2)}.`;
  const blockerText = params.blockingReasons.length > 0
    ? `The main caution is ${params.blockingReasons.slice(0, 3).join("; ")}.`
    : "There are no major scanner blockers listed.";

  return [
    `I checked the live multi-timeframe chart windows: ${timeframeText}.`,
    alignmentText,
    levelText,
    rrText,
    srText,
    blockerText,
  ].filter(Boolean).join(" ");
}

export function buildChartReviewSummary(
  chartReview: CurrentChartReviewResult,
): string {
  return [
    `Current multi-timeframe chart conclusion: ${chartReview.conclusion}.`,
    `Detected chart direction: ${chartReview.direction ?? "neutral"}; trade direction alignment: ${chartReview.alignsWithTradeDirection === null ? "unknown" : chartReview.alignsWithTradeDirection ? "aligned" : "against trade"}.`,
    `Chart confidence: ${chartReview.confidencePercent === null ? "n/a" : `${chartReview.confidencePercent}%`} (${chartReview.confidence ?? "no confirmed scanner bucket"}).`,
    `Estimated option recovery/profit chance: ${chartReview.estimatedProfitChancePercent === null ? "n/a" : `${chartReview.estimatedProfitChancePercent}%`}.`,
    `Reference=${chartReview.referencePrice ?? "n/a"}, invalidation=${chartReview.invalidationLevel ?? "n/a"} (${chartReview.invalidationReason ?? "n/a"}), target=${chartReview.targetLevel ?? "n/a"} (${chartReview.targetReason ?? "n/a"}), chart R:R=${chartReview.actualRewardRiskRatio ?? "n/a"}.`,
    `Nearest support below=${chartReview.nearestSupportBelow ?? "n/a"}, nearest resistance above=${chartReview.nearestResistanceAbove ?? "n/a"}, level source=${chartReview.levelSource}.`,
    `Timeframes: ${chartReview.timeframes.map((item) => `${item.label} bars=${item.barCount}, move=${item.movePct ?? "n/a"}%, close=${item.latestClose ?? "n/a"}${item.volumeRatio === null ? "" : `, volume=${item.volumeRatio}x`}`).join(" | ")}.`,
    `Blocking reasons: ${chartReview.topBlockingReasons.length > 0 ? chartReview.topBlockingReasons.join("; ") : "none"}.`,
    `Plain-English market read: ${chartReview.plainEnglishSummary}`,
    `Scanner narrative: ${chartReview.reason}`,
  ].join(" ");
}

export async function readCurrentChartReview(
  input: CurrentChartReviewInput,
): Promise<CurrentChartReviewResult> {
  try {
    const [review, barsByView] = await Promise.all([
      runSingleSymbolTradeStationAnalysis(input.symbol, input.baseUrl),
      loadCurrentChartReviewBars(input.symbol, input.baseUrl),
    ]);

    const debug = review.confirmationDebug;
    const expectedDirection = toMarketDirection(input.direction);
    const alignsWithTradeDirection = review.direction
      ? review.direction === expectedDirection
      : null;
    const timeframes = buildTimeframeReads(barsByView);
    const latestDailyClose = timeframes.find((item) => item.label === "1D")?.latestClose ?? null;
    const referencePrice = positiveNumberOrNull(input.currentUnderlyingPrice ?? latestDailyClose);
    const dailyBars = barsByView["1D"] ?? [];
    const bars3M = barsByView["3M"] ?? [];
    const bars1Y = barsByView["1Y"] ?? [];
    const highs = Object.values(barsByView)
      .flatMap((bars) => bars.map((bar) => readBarNumber(bar, ["High"])))
      .filter((value): value is number => value !== null);
    const lows = Object.values(barsByView)
      .flatMap((bars) => bars.map((bar) => readBarNumber(bar, ["Low"])))
      .filter((value): value is number => value !== null);
    const nearestSupportBelow = referencePrice === null ? null : nearestBelow(lows, referencePrice);
    const nearestResistanceAbove = referencePrice === null ? null : nearestAbove(highs, referencePrice);
    const tradeDirectionGeometry = referencePrice === null
      ? null
      : evaluateChartAnchoredAsymmetryFromBars(
        input.symbol,
        expectedDirection,
        referencePrice,
        dailyBars,
        bars3M,
        bars1Y,
      );
    const invalidationLevel = positiveNumberOrNull(
      tradeDirectionGeometry?.invalidationUnderlying
      ?? (expectedDirection === "bullish" ? nearestSupportBelow : nearestResistanceAbove),
    );
    const targetLevel = positiveNumberOrNull(
      tradeDirectionGeometry?.targetUnderlying
      ?? (expectedDirection === "bullish" ? nearestResistanceAbove : nearestSupportBelow),
    );
    const actualRewardRiskRatio =
      positiveNumberOrNull(tradeDirectionGeometry?.rewardRiskRatio)
      ?? computeRewardRiskRatio({
        direction: expectedDirection,
        referencePrice,
        invalidationLevel,
        targetLevel,
      });
    const topBlockingReasons = Array.from(new Set([
      ...(debug?.topBlockingReasons ?? []),
      ...(alignsWithTradeDirection === false ? ["fresh chart direction is against this trade"] : []),
      ...(tradeDirectionGeometry?.pass === false ? [tradeDirectionGeometry.reason] : []),
    ])).filter((reason) => reason.trim().length > 0);
    const confidencePercent = midpointConfidencePercent(review.confidence);
    const estimatedProfitChancePercent = estimateProfitChancePercent({
      decisionDirection: input.direction,
      chartConclusion: review.conclusion,
      alignsWithTradeDirection,
      rewardRiskRatio: actualRewardRiskRatio,
      optionReturnPct: input.optionReturnPct,
      timeframes,
    });
    const plainEnglishSummary = buildPlainEnglishMarketRead({
      input,
      conclusion: review.conclusion,
      alignsWithTradeDirection,
      referencePrice,
      invalidationLevel,
      targetLevel,
      rewardRiskRatio: actualRewardRiskRatio,
      nearestSupportBelow,
      nearestResistanceAbove,
      timeframes,
      blockingReasons: topBlockingReasons,
    });

    return {
      conclusion: review.conclusion,
      direction: review.direction,
      confidence: review.confidence,
      confidencePercent,
      estimatedProfitChancePercent,
      reason: review.reason,
      plainEnglishSummary,
      alignsWithTradeDirection,
      referencePrice,
      invalidationLevel,
      targetLevel,
      invalidationReason: tradeDirectionGeometry?.invalidationReason ?? null,
      targetReason: tradeDirectionGeometry?.targetReason ?? null,
      actualRewardRiskRatio,
      nearestSupportBelow,
      nearestResistanceAbove,
      levelSource: referencePrice === null ? "unavailable" : "trade_direction_chart",
      timeframes,
      topBlockingReasons,
    };
  } catch (error) {
    return {
      conclusion: "unavailable",
      direction: null,
      confidence: null,
      confidencePercent: null,
      estimatedProfitChancePercent: null,
      reason: error instanceof Error ? error.message : "Failed to read current chart.",
      plainEnglishSummary:
        "I could not complete the live multi-timeframe chart read, so this review cannot honestly claim chart-backed levels or high-confidence reasoning.",
      alignsWithTradeDirection: null,
      referencePrice: null,
      invalidationLevel: null,
      targetLevel: null,
      invalidationReason: null,
      targetReason: null,
      actualRewardRiskRatio: null,
      nearestSupportBelow: null,
      nearestResistanceAbove: null,
      levelSource: "unavailable",
      timeframes: [],
      topBlockingReasons: ["current chart review unavailable"],
    };
  }
}
