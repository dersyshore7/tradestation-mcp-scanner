import { decideAiManagementAction, enforceAiManagementGuardrails } from "../automation/aiManager.js";
import { readPaperTraderConfig } from "../automation/config.js";
import { createAutomationTradeStationClient } from "../automation/tradestation.js";
import { evaluateChartAnchoredAsymmetryFromBars } from "../app/chartAnchoredTradability.js";
import { normalizeBar, parseBars, runSingleSymbolTradeStationAnalysis } from "../app/runScan.js";
import { createJournalTrade, getJournalTradeById } from "../journal/repository.js";
import type { AccountMode, JournalTradeDetail, TradeDirection } from "../journal/types.js";
import { createTradeStationGetFetcher } from "../tradestation/client.js";

export type LateTradeReviewInput = {
  account_mode: AccountMode;
  symbol: string;
  direction: TradeDirection;
  entry_date: string;
  entry_time: string | null;
  expiration_date: string | null;
  contracts: number;
  option_entry_price: number;
  underlying_entry_price: number | null;
  current_underlying_price: number | null;
  current_option_mid: number | null;
  option_symbol: string | null;
  current_stop_underlying: number | null;
  current_target_underlying: number | null;
  rationale: string | null;
  entry_notes: string | null;
  save_to_journal: boolean;
};

export type LateTradeReviewResult = {
  decision: {
    action: "hold" | "update_levels" | "exit_now";
    updatedStopUnderlying: number | null;
    updatedTargetUnderlying: number | null;
    confidence: "low" | "medium" | "high";
    confidencePercent: number;
    profitChancePercent: number | null;
    thesis: string;
    note: string;
    plainEnglishExplanation: string;
  };
  trade: JournalTradeDetail | null;
  metrics: {
    currentUnderlyingPrice: number | null;
    currentOptionMid: number | null;
    optionReturnPct: number | null;
    progressToTargetPct: number | null;
  };
  quote_status: {
    underlying: "manual" | "fetched" | "missing";
    option: "manual" | "fetched" | "missing";
    errors: string[];
  };
  chart_review: {
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
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Payload must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return readString(value, field);
}

function readNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim().replace(/,/g, ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`${field} must be a valid number.`);
}

function optionalPositiveNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = readNumber(value, field);
  if (parsed <= 0) {
    throw new Error(`${field} must be > 0.`);
  }
  return parsed;
}

function readPositiveNumber(value: unknown, field: string): number {
  const parsed = readNumber(value, field);
  if (parsed <= 0) {
    throw new Error(`${field} must be > 0.`);
  }
  return parsed;
}

function readPositiveInteger(value: unknown, field: string): number {
  const parsed = readNumber(value, field);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be an integer > 0.`);
  }
  return parsed;
}

function readDate(value: unknown, field: string): string {
  const date = readString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${field} must be YYYY-MM-DD.`);
  }
  return date;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return readDate(value, field);
}

function optionalTime(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const time = readString(value, field);
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time)) {
    throw new Error(`${field} must be HH:MM or HH:MM:SS.`);
  }
  return time;
}

function coerceDirection(value: unknown): TradeDirection {
  const raw = readString(value, "direction").toUpperCase();
  if (raw === "CALL" || raw === "BULLISH") {
    return "CALL";
  }
  if (raw === "PUT" || raw === "BEARISH") {
    return "PUT";
  }
  throw new Error("direction must be CALL or PUT.");
}

function coerceAccountMode(value: unknown): AccountMode {
  const raw = readString(value, "account_mode").toLowerCase();
  if (raw === "paper" || raw === "live") {
    return raw;
  }
  throw new Error("account_mode must be paper or live.");
}

function calculateDteAtEntry(entryDate: string, expirationDate: string | null): number | null {
  if (!expirationDate) {
    return null;
  }
  const entry = new Date(`${entryDate}T00:00:00Z`);
  const expiration = new Date(`${expirationDate}T00:00:00Z`);
  if (Number.isNaN(entry.getTime()) || Number.isNaN(expiration.getTime())) {
    return null;
  }
  const days = Math.ceil((expiration.getTime() - entry.getTime()) / 86400000);
  return days > 0 ? days : null;
}

function computeProgressToTargetPct(params: {
  direction: TradeDirection;
  entryUnderlyingPrice: number | null;
  currentUnderlyingPrice: number | null;
  targetUnderlyingPrice: number | null;
}): number | null {
  const { direction, entryUnderlyingPrice, currentUnderlyingPrice, targetUnderlyingPrice } = params;
  if (
    entryUnderlyingPrice === null
    || currentUnderlyingPrice === null
    || targetUnderlyingPrice === null
    || entryUnderlyingPrice === targetUnderlyingPrice
  ) {
    return null;
  }

  const progress = direction === "CALL"
    ? (currentUnderlyingPrice - entryUnderlyingPrice) / (targetUnderlyingPrice - entryUnderlyingPrice)
    : (entryUnderlyingPrice - currentUnderlyingPrice) / (entryUnderlyingPrice - targetUnderlyingPrice);

  return Number.isFinite(progress) ? Number((progress * 100).toFixed(1)) : null;
}

function computeOptionReturnPct(entryOptionPrice: number, currentOptionMid: number | null): number | null {
  if (currentOptionMid === null || entryOptionPrice <= 0) {
    return null;
  }
  return Number((((currentOptionMid - entryOptionPrice) / entryOptionPrice) * 100).toFixed(1));
}

function toMarketDirection(direction: TradeDirection): "bullish" | "bearish" {
  return direction === "CALL" ? "bullish" : "bearish";
}

type MarketDirection = ReturnType<typeof toMarketDirection>;
type LateReviewTimeframeLabel = LateTradeReviewResult["chart_review"]["timeframes"][number]["label"];
type LateReviewTimeframeBars = Record<LateReviewTimeframeLabel, Record<string, unknown>[]>;

const LATE_REVIEW_BAR_CONFIG: Record<
  LateReviewTimeframeLabel,
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
  chartConclusion: LateTradeReviewResult["chart_review"]["conclusion"];
  chartDirection: "bullish" | "bearish" | null;
  alignsWithTradeDirection: boolean | null;
  rewardRiskRatio: number | null;
  optionReturnPct: number | null;
  timeframes: LateTradeReviewResult["chart_review"]["timeframes"];
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

async function loadLateReviewBars(
  symbol: string,
  baseUrl: string,
): Promise<LateReviewTimeframeBars | null> {
  const get = await createTradeStationGetFetcher(baseUrl);
  const entries = await Promise.all(
    (Object.entries(LATE_REVIEW_BAR_CONFIG) as [
      LateReviewTimeframeLabel,
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

  const barsByView = {} as LateReviewTimeframeBars;
  for (const [label, bars] of entries) {
    barsByView[label] = bars;
  }

  return barsByView;
}

function buildTimeframeReads(
  barsByView: LateReviewTimeframeBars,
): LateTradeReviewResult["chart_review"]["timeframes"] {
  return (Object.keys(LATE_REVIEW_BAR_CONFIG) as LateReviewTimeframeLabel[]).map((label) => {
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
  input: LateTradeReviewInput;
  conclusion: LateTradeReviewResult["chart_review"]["conclusion"];
  scannerDirection: "bullish" | "bearish" | null;
  alignsWithTradeDirection: boolean | null;
  referencePrice: number | null;
  invalidationLevel: number | null;
  targetLevel: number | null;
  rewardRiskRatio: number | null;
  nearestSupportBelow: number | null;
  nearestResistanceAbove: number | null;
  timeframes: LateTradeReviewResult["chart_review"]["timeframes"];
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

function buildChartReviewSummary(
  chartReview: LateTradeReviewResult["chart_review"],
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

export function validateLateTradeReviewPayload(payload: unknown): LateTradeReviewInput {
  const input = asRecord(payload);
  const entryDate = readDate(input.entry_date, "entry_date");
  const expirationDate = optionalDate(input.expiration_date, "expiration_date");
  if (expirationDate && expirationDate < entryDate) {
    throw new Error("expiration_date must be on/after entry_date.");
  }

  return {
    account_mode: coerceAccountMode(input.account_mode ?? "paper"),
    symbol: readString(input.symbol, "symbol").toUpperCase(),
    direction: coerceDirection(input.direction),
    entry_date: entryDate,
    entry_time: optionalTime(input.entry_time, "entry_time"),
    expiration_date: expirationDate,
    contracts: readPositiveInteger(input.contracts, "contracts"),
    option_entry_price: readPositiveNumber(input.option_entry_price, "option_entry_price"),
    underlying_entry_price: optionalPositiveNumber(input.underlying_entry_price, "underlying_entry_price"),
    current_underlying_price: optionalPositiveNumber(input.current_underlying_price, "current_underlying_price"),
    current_option_mid: optionalPositiveNumber(input.current_option_mid, "current_option_mid"),
    option_symbol: optionalString(input.option_symbol, "option_symbol"),
    current_stop_underlying: optionalPositiveNumber(input.current_stop_underlying, "current_stop_underlying"),
    current_target_underlying: optionalPositiveNumber(input.current_target_underlying, "current_target_underlying"),
    rationale: optionalString(input.rationale, "rationale"),
    entry_notes: optionalString(input.entry_notes, "entry_notes"),
    save_to_journal: input.save_to_journal !== false,
  };
}

async function resolveCurrentPrices(input: LateTradeReviewInput): Promise<{
  currentUnderlyingPrice: number | null;
  currentOptionMid: number | null;
  quoteStatus: LateTradeReviewResult["quote_status"];
}> {
  let currentUnderlyingPrice = input.current_underlying_price;
  let currentOptionMid = input.current_option_mid;
  const errors: string[] = [];

  if (currentUnderlyingPrice === null || (currentOptionMid === null && input.option_symbol)) {
    try {
      const client = await createAutomationTradeStationClient(readPaperTraderConfig().automationBaseUrl);
      if (currentUnderlyingPrice === null) {
        const quote = await client.fetchQuote(input.symbol);
        currentUnderlyingPrice = quote.last;
      }
      if (currentOptionMid === null && input.option_symbol) {
        const quote = await client.fetchQuote(input.option_symbol);
        currentOptionMid = quote.mid ?? quote.last;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Failed to fetch current quotes.");
    }
  }

  return {
    currentUnderlyingPrice,
    currentOptionMid,
    quoteStatus: {
      underlying: input.current_underlying_price !== null
        ? "manual"
        : currentUnderlyingPrice !== null
          ? "fetched"
          : "missing",
      option: input.current_option_mid !== null
        ? "manual"
        : currentOptionMid !== null
          ? "fetched"
          : "missing",
      errors,
    },
  };
}

async function readCurrentChartReview(
  input: LateTradeReviewInput,
  currentUnderlyingPrice: number | null,
  optionReturnPct: number | null,
): Promise<LateTradeReviewResult["chart_review"]> {
  try {
    const baseUrl = readPaperTraderConfig().automationBaseUrl;
    const [review, barsByView] = await Promise.all([
      runSingleSymbolTradeStationAnalysis(input.symbol, baseUrl),
      loadLateReviewBars(input.symbol, baseUrl),
    ]);
    if (!barsByView) {
      throw new Error("TradeStation chart bars were unavailable.");
    }

    const debug = review.confirmationDebug;
    const expectedDirection = toMarketDirection(input.direction);
    const alignsWithTradeDirection = review.direction
      ? review.direction === expectedDirection
      : null;
    const timeframes = buildTimeframeReads(barsByView);
    const latestDailyClose = timeframes.find((item) => item.label === "1D")?.latestClose ?? null;
    const referencePrice = positiveNumberOrNull(currentUnderlyingPrice ?? latestDailyClose);
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
      chartDirection: review.direction,
      alignsWithTradeDirection,
      rewardRiskRatio: actualRewardRiskRatio,
      optionReturnPct,
      timeframes,
    });
    const plainEnglishSummary = buildPlainEnglishMarketRead({
      input,
      conclusion: review.conclusion,
      scannerDirection: review.direction,
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

export async function reviewLateTrade(input: LateTradeReviewInput): Promise<LateTradeReviewResult> {
  const { currentUnderlyingPrice, currentOptionMid, quoteStatus } =
    await resolveCurrentPrices(input);
  const dteAtEntry = calculateDteAtEntry(input.entry_date, input.expiration_date);
  const positionCostUsd = input.contracts * input.option_entry_price * 100;
  const optionReturnPct = computeOptionReturnPct(input.option_entry_price, currentOptionMid);
  const chartReview = await readCurrentChartReview(
    input,
    currentUnderlyingPrice,
    optionReturnPct,
  );
  const progressToTargetPct = computeProgressToTargetPct({
    direction: input.direction,
    entryUnderlyingPrice: input.underlying_entry_price,
    currentUnderlyingPrice,
    targetUnderlyingPrice: input.current_target_underlying,
  });
  const rawDecision = await decideAiManagementAction({
    symbol: input.symbol,
    direction: input.direction,
    setupType: "manual_late_entry",
    confidenceBucket: null,
    entryDate: input.entry_date,
    expirationDate: input.expiration_date,
    dteAtEntry,
    underlyingEntryPrice: input.underlying_entry_price,
    optionEntryPrice: input.option_entry_price,
    currentUnderlyingPrice,
    currentOptionMid,
    currentStopUnderlying: input.current_stop_underlying,
    currentTargetUnderlying: input.current_target_underlying,
    originalStopUnderlying: input.current_stop_underlying,
    originalTargetUnderlying: input.current_target_underlying,
    timeExitDate: null,
    progressToTargetPct,
    optionReturnPct,
    rationale: input.rationale,
    currentChartReviewSummary: buildChartReviewSummary(chartReview),
    lastManagementNote: null,
    lastManagementThesis: null,
    managementHistorySummary: "Late manual review: no prior saved scanner recommendation or management history is available.",
    policyFeedbackSummary: null,
    trainedPolicySummary: null,
    trainedPolicyRecommendedAction: null,
  });
  const decision = enforceAiManagementGuardrails(
    input.direction,
    input.current_stop_underlying,
    input.current_target_underlying,
    currentUnderlyingPrice,
    rawDecision,
  );
  let trade: JournalTradeDetail | null = null;

  if (input.save_to_journal) {
    const created = await createJournalTrade({
      account_mode: input.account_mode,
      entry_date: input.entry_date,
      entry_time: input.entry_time,
      contracts: input.contracts,
      option_entry_price: input.option_entry_price,
      entry_notes: input.entry_notes ?? "Late manual entry reviewed after the trade was already open.",
      planned_trade: {
        scan_run_id: `late_review_${Date.now()}`,
        symbol: input.symbol,
        direction: input.direction,
        expiration_date: input.expiration_date,
        dte_at_entry: dteAtEntry,
        position_cost_usd: positionCostUsd,
        underlying_entry_price: input.underlying_entry_price,
        setup_type: "manual_late_entry",
        confidence_bucket: "late_manual",
        intended_stop_underlying: input.current_stop_underlying,
        intended_target_underlying: input.current_target_underlying,
      },
      signal_snapshot_json: {
        lateTradeReview: {
          input,
          currentUnderlyingPrice,
          currentOptionMid,
          quoteStatus,
          chartReview,
          decision,
          reviewedAt: new Date().toISOString(),
          note: "Decision support only. No order was placed.",
        },
        automation: {
          lane: "manual_late_review",
          paperTrader: {
            optionSymbol: input.option_symbol,
            quantity: input.contracts,
            intendedStopUnderlying: input.current_stop_underlying,
            intendedTargetUnderlying: input.current_target_underlying,
            activeStopUnderlying: decision.updatedStopUnderlying ?? input.current_stop_underlying,
            activeTargetUnderlying: decision.updatedTargetUnderlying ?? input.current_target_underlying,
            managementStyle: "manual_review",
            lastManagementAction: decision.action,
            lastManagementConfidence: decision.confidence,
            lastManagementNote: decision.note,
            lastManagementThesis: decision.thesis,
            lastManagementAt: new Date().toISOString(),
          },
        },
      },
    });

    trade = await getJournalTradeById(created.id);
  }

  return {
    decision,
    trade,
    metrics: {
      currentUnderlyingPrice,
      currentOptionMid,
      optionReturnPct,
      progressToTargetPct,
    },
    quote_status: quoteStatus,
    chart_review: chartReview,
  };
}
