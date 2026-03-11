import { getFakeConfidence, type ScanConfidence, type ScanDirection } from "../scanner/scoring.js";
import { createTradeStationGetFetcher } from "../tradestation/client.js";

const V1_SCAN_UNIVERSE_CONFIG = {
  symbols: [
    "AAPL",
    "MSFT",
    "NVDA",
    "AMZN",
    "META",
    "GOOGL",
    "TSLA",
    "AMD",
    "NFLX",
    "ADBE",
    "CRM",
    "ORCL",
    "AVGO",
    "QCOM",
    "INTC",
    "CSCO",
    "IBM",
    "NOW",
    "JPM",
    "BAC",
    "WFC",
    "C",
    "GS",
    "MS",
    "BLK",
    "UNH",
    "JNJ",
    "LLY",
    "MRK",
    "ABBV",
    "PFE",
    "TMO",
    "XOM",
    "CVX",
    "COP",
    "SLB",
    "EOG",
    "OXY",
    "WMT",
    "COST",
    "HD",
    "LOW",
    "MCD",
    "SBUX",
    "NKE",
    "DIS",
    "CMG",
    "BKNG",
    "CAT",
    "DE",
    "GE",
    "RTX",
    "HON",
    "UPS",
    "UNP",
    "QQQ",
    "SPY",
    "IWM",
    "XLF",
    "SMH",
  ],
} as const;

const V1_SCAN_UNIVERSE = V1_SCAN_UNIVERSE_CONFIG.symbols;
const V1_SCAN_UNIVERSE_SET = new Set<string>(V1_SCAN_UNIVERSE);

export type ScanInput = {
  prompt: string;
  excludedTickers?: string[];
};

export type ScanResult = {
  ticker: string | null;
  direction: ScanDirection | null;
  confidence: ScanConfidence | null;
  conclusion: "confirmed" | "rejected" | "no_trade_today";
  reason: string;
};

type SymbolPromptMatch = {
  action: "analyze" | "review" | "scan";
  symbol: string;
};

const NON_TICKER_TOKENS = new Set(["FOR", "THIS", "WEEK", "FIND", "BULLISH", "SETUPS", "NEW", "RUN"]);

type Stage1Candidate = {
  symbol: string;
  lastPrice: number;
  averageVolume: number | null;
};

type OptionsCandidate = Stage1Candidate & {
  targetExpiration: string;
  targetDte: number;
  optionOpenInterest: number;
  optionSpread: number;
  optionMid: number;
};

type Stage2SymbolDiagnostic = {
  symbol: string;
  underlyingQuoteRequestTarget: string | null;
  underlyingQuoteStatus: number | null;
  underlyingPriceFieldCandidates: { field: string; rawValue: string | number | null; parsedValue: number | null }[];
  underlyingPriceFieldUsed: string | null;
  underlyingPrice: number | null;
  underlyingPriceFallback: string | null;
  expirationsFound: boolean;
  rawStrikeCount: number | null;
  normalizedStrikeCount: number | null;
  selectedExpiration: string | null;
  selectedDte: number | null;
  selectedExpirationApiValue: string | null;
  selectedStrike: number | null;
  evaluatedContract: string | null;
  bid: number | null;
  ask: number | null;
  spreadWidth: number | null;
  spreadPercent: number | null;
  openInterest: number | null;
  optionQuoteAttempts: {
    optionSymbol: string;
    requestTarget: string;
    status: number;
    rawQuotePayloadSample: Record<string, unknown> | null;
    parsedBid: number | null;
    parsedAsk: number | null;
    parsedOpenInterest: number | null;
    spreadWidth: number | null;
    spreadPercent: number | null;
    outcome: string;
  }[];
  pass: boolean;
  reason: string;
};

type StrikeCandidate = {
  strike: number;
  callSymbol: string | null;
  putSymbol: string | null;
};

type ChartCandidate = OptionsCandidate & {
  chartDirection: ScanDirection;
  chartMovePct: number;
  volumeRatio: number | null;
  chartReviewSummary: string;
  chartReviewScore: number;
  chartDiagnostics: Stage3Diagnostics;
};

type MultiTimeframeView = "1D" | "1W" | "1M" | "3M" | "1Y";

type MultiTimeframeBars = Record<MultiTimeframeView, Record<string, unknown>[]>;

type ChartReviewResult = {
  pass: boolean;
  direction: ScanDirection | null;
  movePct: number;
  volumeRatio: number | null;
  score: number;
  summary: string;
  diagnostics: Stage3Diagnostics;
};

type Stage3CheckDiagnostic = {
  check: string;
  pass: boolean;
  reason: string;
};

type Stage3Diagnostics = {
  timeframeDiagnostics: Record<MultiTimeframeView, Stage3TimeframeDiagnostic>;
  move1D: number | null;
  move1W: number | null;
  bias1D: ScanDirection | "neutral";
  bias1W: ScanDirection | "neutral";
  alignmentRule: string;
  alignmentPass: boolean;
  alignmentReason: string;
  candleBodySize: number | null;
  candleRange: number | null;
  bodyToRange: number | null;
  wickiness: number | null;
  closeLocation: number | null;
  volumeDataPresent: boolean;
  lastVolume: number | null;
  priorVolumeBarsWithData: number;
  averageVolume: number | null;
  volumeRatioComputation: string;
  resistanceLevel: number | null;
  supportLevel: number | null;
  roomPct: number | null;
  checks: Stage3CheckDiagnostic[];
};

type Stage3TimeframeDiagnostic = {
  requestTarget: string;
  status: number | null;
  barCount: number;
  latestParsedBarSample: Record<string, unknown> | null;
  parsedOpen: boolean;
  parsedHigh: boolean;
  parsedLow: boolean;
  parsedClose: boolean;
  parsedVolume: boolean;
};

type StageFailureSummary = Record<string, number>;

type Stage3NearMiss = {
  symbol: string;
  direction: ScanDirection | "none";
  score: number;
  failReasons: string[];
};

type FinalRankingEntry = {
  symbol: string;
  direction: ScanDirection;
  score: number | null;
  enteredFinalRanking: boolean;
  selected: boolean;
  reason: string;
  scoreInputs: {
    movePct: number;
    optionOpenInterest: number;
    optionSpread: number;
    optionMid: number;
    volumeRatio: number | null;
    chartReviewScore: number;
  };
};

export type StarterUniverseTelemetry = {
  stageCounts: {
    stage1Entered: number;
    stage1Passed: number;
    stage2Passed: number;
    stage3Passed: number;
    finalRanking: number;
  };
  stageSymbols: {
    stage1Entered: string[];
    stage1Passed: string[];
    stage2Passed: string[];
    stage3Passed: string[];
    finalRanking: string[];
  };
  stage3PassedDetails: {
    symbol: string;
    direction: ScanDirection;
    score: number;
    summary: string;
    whyPassed: string;
  }[];
  finalRankingDebug: FinalRankingEntry[];
  rejectionSummaries: {
    stage1: StageFailureSummary;
    stage2: StageFailureSummary;
    stage3: StageFailureSummary;
  };
  nearMisses: Stage3NearMiss[];
  finalSelectedSymbol: string | null;
};

function buildFinalRanking(stage3Passed: ChartCandidate[]): { ranked: (ChartCandidate & { score: number })[]; debug: FinalRankingEntry[] } {
  const debug = stage3Passed.map((candidate) => {
    const computedScore = scoreStage3Candidate(candidate);
    const score = Number.isFinite(computedScore) ? computedScore : null;
    const scoreInputs = {
      movePct: candidate.chartMovePct,
      optionOpenInterest: candidate.optionOpenInterest,
      optionSpread: candidate.optionSpread,
      optionMid: candidate.optionMid,
      volumeRatio: candidate.volumeRatio,
      chartReviewScore: candidate.chartReviewScore,
    };

    if (score === null) {
      return {
        symbol: candidate.symbol,
        direction: candidate.chartDirection,
        score,
        enteredFinalRanking: false,
        selected: false,
        reason: "missing final score",
        scoreInputs,
      };
    }

    return {
      symbol: candidate.symbol,
      direction: candidate.chartDirection,
      score,
      enteredFinalRanking: true,
      selected: false,
      reason: "entered final ranking",
      scoreInputs,
    };
  });

  const ranked = stage3Passed
    .map((candidate) => ({ ...candidate, score: scoreStage3Candidate(candidate) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score);

  const topScore = ranked[0]?.score ?? null;
  for (const item of debug) {
    if (!item.enteredFinalRanking) {
      continue;
    }

    if (item.symbol === ranked[0]?.symbol) {
      item.selected = true;
      item.reason = "selected as top final score";
      continue;
    }

    if (topScore !== null && item.score !== null) {
      item.reason = `ranking threshold: score ${item.score.toFixed(2)} below top ${topScore.toFixed(2)}`;
    } else {
      item.reason = "filtered out unexpectedly";
    }
  }

  return { ranked, debug };
}

function logFinalRankingDebugSection(entries: FinalRankingEntry[]): void {
  if (process.env.SCANNER_DEBUG !== "1") {
    return;
  }

  console.log("[scanner:debug] Stage 3 -> final ranking details:");
  if (entries.length === 0) {
    console.log("[scanner:debug] (no Stage 3 passed symbols)");
    return;
  }

  for (const item of entries) {
    const score = item.score === null ? "n/a" : item.score.toFixed(2);
    console.log(
      `[scanner:debug] ${item.symbol}: dir=${item.direction} | score=${score} | enteredFinalRanking=${item.enteredFinalRanking ? "yes" : "no"} | selected=${item.selected ? "yes" : "no"} | reason=${item.reason} | inputs=${JSON.stringify(item.scoreInputs)}`,
    );
  }
}

type MultiTimeframeBarsLoadResult = {
  barsByView: MultiTimeframeBars | null;
  timeframeDiagnostics: Record<MultiTimeframeView, Stage3TimeframeDiagnostic>;
};

const MULTI_TIMEFRAME_BAR_CONFIG: Record<MultiTimeframeView, { interval: number; unit: "Daily" | "Weekly"; barsBack: number }> = {
  "1D": { interval: 1, unit: "Daily", barsBack: 20 },
  "1W": { interval: 1, unit: "Daily", barsBack: 35 },
  "1M": { interval: 1, unit: "Daily", barsBack: 80 },
  "3M": { interval: 1, unit: "Daily", barsBack: 160 },
  "1Y": { interval: 1, unit: "Weekly", barsBack: 60 },
};

function pickTicker(candidates: string[], excludedTickers: string[]): string | null {
  const excludedSet = new Set(excludedTickers.map((item) => item.toUpperCase()));
  const picked = candidates.find((ticker) => !excludedSet.has(ticker.toUpperCase()));
  return picked ?? null;
}

function isStarterUniverseTicker(symbol: string): boolean {
  return V1_SCAN_UNIVERSE_SET.has(symbol.toUpperCase());
}

function logGeneralScanDebug(stage: string, symbols: string[]): void {
  if (process.env.SCANNER_DEBUG !== "1") {
    return;
  }

  console.log(`[scanner:debug] ${stage}: ${symbols.length > 0 ? symbols.join(", ") : "(none)"}`);
}

function logStage2Diagnostics(diagnostics: Stage2SymbolDiagnostic[]): void {
  if (process.env.SCANNER_DEBUG !== "1") {
    return;
  }

  for (const item of diagnostics) {
    console.log(`[scanner:debug:stage2] ${item.symbol}: ${JSON.stringify(item)}`);
  }
}

function incrementSummary(summary: StageFailureSummary, reason: string): void {
  summary[reason] = (summary[reason] ?? 0) + 1;
}

function categorizeStage2Failure(reason: string): string {
  if (reason.includes("OI threshold")) {
    return "oi";
  }
  if (reason.includes("spread threshold")) {
    return "spread";
  }
  return "other";
}

function getStage3FailReasons(review: ChartReviewResult): string[] {
  const failedChecks = review.diagnostics.checks.filter((check) => !check.pass).map((check) => check.check);
  const reasons: string[] = [];

  if (failedChecks.includes("alignment")) {
    reasons.push("alignment");
  }
  if (failedChecks.includes("expansion")) {
    reasons.push("weak expansion");
  }
  if (failedChecks.includes("volume")) {
    reasons.push("weak volume");
  }
  if (failedChecks.includes("continuation")) {
    reasons.push("rejection risk");
  }
  if (reasons.length === 0 && failedChecks.length > 0) {
    reasons.push(failedChecks[0] ?? "other");
  }
  if (reasons.length === 0) {
    reasons.push("other");
  }

  return reasons;
}

function scoreStage3Candidate(candidate: ChartCandidate): number {
  const moveScore = Math.min(Math.abs(candidate.chartMovePct), 6);
  const oiScore = Math.min(candidate.optionOpenInterest / 500, 6);
  const spreadScore = Math.max(0, 3 - (candidate.optionSpread / Math.max(candidate.optionMid, 0.01)) * 10);
  const volumeScore = candidate.volumeRatio === null ? 1 : Math.min(candidate.volumeRatio, 2);
  return moveScore + oiScore + spreadScore + volumeScore + candidate.chartReviewScore;
}

function summarizePassingChecks(checks: Stage3CheckDiagnostic[]): string {
  const passingChecks = checks.filter((check) => check.pass).map((check) => check.check);
  return passingChecks.length > 0 ? passingChecks.join(", ") : "no failed checks";
}

async function loadMultiTimeframeBars(
  get: (path: string) => Promise<Response>,
  symbol: string,
): Promise<MultiTimeframeBarsLoadResult> {
  const result = {} as MultiTimeframeBars;
  const timeframeDiagnostics = {} as Record<MultiTimeframeView, Stage3TimeframeDiagnostic>;
  let allViewsLoaded = true;

  for (const [view, config] of Object.entries(MULTI_TIMEFRAME_BAR_CONFIG) as [
    MultiTimeframeView,
    { interval: number; unit: "Daily" | "Weekly"; barsBack: number },
  ][]) {
    const requestTarget = `/marketdata/barcharts/${encodeURIComponent(symbol)}?interval=${config.interval}&unit=${config.unit}&barsback=${config.barsBack}`;
    const response = await get(requestTarget);

    if (!response.ok) {
      allViewsLoaded = false;
      timeframeDiagnostics[view] = {
        requestTarget,
        status: response.status,
        barCount: 0,
        latestParsedBarSample: null,
        parsedOpen: false,
        parsedHigh: false,
        parsedLow: false,
        parsedClose: false,
        parsedVolume: false,
      };
      continue;
    }

    const payload = await response.json();
    const bars = parseBars(payload).map((bar) => normalizeBar(bar));
    const latestBar = bars[bars.length - 1] ?? null;
    const parsedOpen = readNumber(latestBar, ["Open"]) !== null;
    const parsedHigh = readNumber(latestBar, ["High"]) !== null;
    const parsedLow = readNumber(latestBar, ["Low"]) !== null;
    const parsedClose = readNumber(latestBar, ["Close"]) !== null;
    const parsedVolume = readNumber(latestBar, ["TotalVolume", "Volume", "Vol", "TotalVolumeTraded"]) !== null;

    timeframeDiagnostics[view] = {
      requestTarget,
      status: response.status,
      barCount: bars.length,
      latestParsedBarSample: latestBar,
      parsedOpen,
      parsedHigh,
      parsedLow,
      parsedClose,
      parsedVolume,
    };

    if (bars.length < 10) {
      allViewsLoaded = false;
      continue;
    }

    result[view] = bars;
  }

  return {
    barsByView: allViewsLoaded ? result : null,
    timeframeDiagnostics,
  };
}

function getMovePctFromBars(bars: Record<string, unknown>[]): number | null {
  const firstBar = bars[0] ?? null;
  const lastBar = bars[bars.length - 1] ?? null;
  const firstClose = readNumber(firstBar, ["Close"]);
  const lastClose = readNumber(lastBar, ["Close"]);

  if (firstClose === null || lastClose === null || firstClose === 0) {
    return null;
  }

  return ((lastClose - firstClose) / firstClose) * 100;
}

function runStage3ChartReview(
  barsByView: MultiTimeframeBars,
  timeframeDiagnostics: Record<MultiTimeframeView, Stage3TimeframeDiagnostic>,
): ChartReviewResult {
  const bars1D = barsByView["1D"];
  const bars1W = barsByView["1W"];
  const bars3M = barsByView["3M"];
  const bars1Y = barsByView["1Y"];

  const move1D = getMovePctFromBars(bars1D);
  const move1W = getMovePctFromBars(bars1W);
  const dayBias: ScanDirection | "neutral" = move1D === null ? "neutral" : move1D >= 0.5 ? "bullish" : move1D <= -0.5 ? "bearish" : "neutral";
  const weekBias: ScanDirection | "neutral" = move1W === null ? "neutral" : move1W >= 0 ? "bullish" : "bearish";
  const alignmentRule = "bullish requires 1D move >= +0.5% and 1W move >= 0%; bearish requires 1D move <= -0.5% and 1W move <= 0%";

  if (move1D === null || move1W === null) {
    return {
      pass: false,
      direction: null,
      movePct: 0,
      volumeRatio: null,
      score: 0,
      summary: "insufficient close data in 1D/1W views",
      diagnostics: {
        timeframeDiagnostics,
        move1D,
        move1W,
        bias1D: dayBias,
        bias1W: weekBias,
        alignmentRule,
        alignmentPass: false,
        alignmentReason: "missing 1D or 1W close data",
        candleBodySize: null,
        candleRange: null,
        bodyToRange: null,
        wickiness: null,
        closeLocation: null,
        volumeDataPresent: false,
        lastVolume: null,
        priorVolumeBarsWithData: 0,
        averageVolume: null,
        volumeRatioComputation: "volumeRatio requires both lastVolume and averageVolume > 0",
        resistanceLevel: null,
        supportLevel: null,
        roomPct: null,
        checks: [{ check: "data-integrity", pass: false, reason: "missing/incomplete bar data (1D or 1W close unavailable)" }],
      },
    };
  }

  const bullishAlignment = move1D >= 0.5 && move1W >= 0;
  const bearishAlignment = move1D <= -0.5 && move1W <= 0;
  const alignmentPass = bullishAlignment || bearishAlignment;
  const direction: ScanDirection | null = bullishAlignment ? "bullish" : bearishAlignment ? "bearish" : null;
  const alignmentReason = alignmentPass
    ? `aligned (${dayBias} day bias with ${weekBias} week bias)`
    : `not aligned (1D=${move1D.toFixed(2)}%, 1W=${move1W.toFixed(2)}%)`;

  if (!direction) {
    return {
      pass: false,
      direction: null,
      movePct: move1D,
      volumeRatio: null,
      score: 0,
      summary: "1D move and 1W context are not aligned",
      diagnostics: {
        timeframeDiagnostics,
        move1D,
        move1W,
        bias1D: dayBias,
        bias1W: weekBias,
        alignmentRule,
        alignmentPass,
        alignmentReason,
        candleBodySize: null,
        candleRange: null,
        bodyToRange: null,
        wickiness: null,
        closeLocation: null,
        volumeDataPresent: false,
        lastVolume: null,
        priorVolumeBarsWithData: 0,
        averageVolume: null,
        volumeRatioComputation: "volumeRatio requires both lastVolume and averageVolume > 0",
        resistanceLevel: null,
        supportLevel: null,
        roomPct: null,
        checks: [{ check: "alignment", pass: false, reason: alignmentReason }],
      },
    };
  }

  const lastBar = bars1D[bars1D.length - 1] ?? null;
  const priorBars = bars1D.slice(0, -1);
  const open = readNumber(lastBar, ["Open"]);
  const high = readNumber(lastBar, ["High"]);
  const low = readNumber(lastBar, ["Low"]);
  const close = readNumber(lastBar, ["Close"]);
  const lastVolume = readNumber(lastBar, ["TotalVolume", "Volume", "Vol", "TotalVolumeTraded"]);

  if (open === null || high === null || low === null || close === null || high <= low) {
    return {
      pass: false,
      direction,
      movePct: move1D,
      volumeRatio: null,
      score: 0,
      summary: "latest 1D candle is incomplete",
      diagnostics: {
        timeframeDiagnostics,
        move1D,
        move1W,
        bias1D: dayBias,
        bias1W: weekBias,
        alignmentRule,
        alignmentPass,
        alignmentReason,
        candleBodySize: null,
        candleRange: null,
        bodyToRange: null,
        wickiness: null,
        closeLocation: null,
        volumeDataPresent: false,
        lastVolume,
        priorVolumeBarsWithData: 0,
        averageVolume: null,
        volumeRatioComputation: "volumeRatio requires both lastVolume and averageVolume > 0",
        resistanceLevel: null,
        supportLevel: null,
        roomPct: null,
        checks: [{ check: "data-integrity", pass: false, reason: "missing/incomplete bar data (latest 1D candle OHLC unavailable)" }],
      },
    };
  }

  let priorRangeSum = 0;
  let priorRangeCount = 0;
  let priorVolumeSum = 0;
  let priorVolumeCount = 0;
  for (const bar of priorBars) {
    const barHigh = readNumber(bar, ["High"]);
    const barLow = readNumber(bar, ["Low"]);
    const barVolume = readNumber(bar, ["TotalVolume", "Volume", "Vol", "TotalVolumeTraded"]);
    if (barHigh !== null && barLow !== null && barHigh > barLow) {
      priorRangeSum += barHigh - barLow;
      priorRangeCount += 1;
    }
    if (barVolume !== null) {
      priorVolumeSum += barVolume;
      priorVolumeCount += 1;
    }
  }

  const range = high - low;
  const body = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const closeLocation = (close - low) / range;
  const averageRange = priorRangeCount > 0 ? priorRangeSum / priorRangeCount : null;
  const expansionRatio = averageRange !== null && averageRange > 0 ? range / averageRange : null;
  const bodyToRange = body / range;
  const wickiness = range > 0 ? (upperWick + lowerWick) / range : null;
  const averageVolume = priorVolumeCount > 0 ? priorVolumeSum / priorVolumeCount : null;
  const volumeRatio = averageVolume !== null && lastVolume !== null && averageVolume > 0 ? lastVolume / averageVolume : null;
  const volumeDataPresent = lastVolume !== null || priorVolumeCount > 0;

  const expansionPass = expansionRatio === null || expansionRatio >= 1.15;
  const bodyQualityPass =
    direction === "bullish"
      ? bodyToRange >= 0.45 && closeLocation >= 0.6 && upperWick <= body
      : bodyToRange >= 0.45 && closeLocation <= 0.4 && lowerWick <= body;
  const volumePass = volumeRatio === null || volumeRatio >= 0.9;

  const closes = bars1D.slice(-7).map((bar) => readNumber(bar, ["Close"]))
    .filter((value): value is number => value !== null);
  let flipCount = 0;
  for (let index = 2; index < closes.length; index += 1) {
    const closeMinus2 = closes[index - 2];
    const closeMinus1 = closes[index - 1];
    const closeCurrent = closes[index];
    if (closeMinus2 === undefined || closeMinus1 === undefined || closeCurrent === undefined) {
      continue;
    }

    const prevDelta = closeMinus1 - closeMinus2;
    const currentDelta = closeCurrent - closeMinus1;
    if (prevDelta === 0 || currentDelta === 0) {
      continue;
    }
    if (Math.sign(prevDelta) !== Math.sign(currentDelta)) {
      flipCount += 1;
    }
  }
  const choppyPass = flipCount <= 3;

  const prevBar = bars1D[bars1D.length - 2] ?? null;
  const prevHigh = readNumber(prevBar, ["High"]);
  const prevLow = readNumber(prevBar, ["Low"]);
  const continuationPass =
    direction === "bullish"
      ? prevHigh !== null && close > prevHigh && close >= open
      : prevLow !== null && close < prevLow && close <= open;

  const highs3M = bars3M.map((bar) => readNumber(bar, ["High"]))
    .filter((value): value is number => value !== null);
  const highs1Y = bars1Y.map((bar) => readNumber(bar, ["High"]))
    .filter((value): value is number => value !== null);
  const lows3M = bars3M.map((bar) => readNumber(bar, ["Low"]))
    .filter((value): value is number => value !== null);
  const lows1Y = bars1Y.map((bar) => readNumber(bar, ["Low"]))
    .filter((value): value is number => value !== null);

  const max3M = highs3M.length > 0 ? Math.max(...highs3M) : null;
  const max1Y = highs1Y.length > 0 ? Math.max(...highs1Y) : null;
  const min3M = lows3M.length > 0 ? Math.min(...lows3M) : null;
  const min1Y = lows1Y.length > 0 ? Math.min(...lows1Y) : null;

  const resistanceLevel = direction === "bullish" ? Math.min(max3M ?? Infinity, max1Y ?? Infinity) : null;
  const supportLevel = direction === "bearish" ? Math.max(min3M ?? -Infinity, min1Y ?? -Infinity) : null;
  const roomPct =
    direction === "bullish" && resistanceLevel !== null && Number.isFinite(resistanceLevel)
      ? ((resistanceLevel - close) / close) * 100
      : direction === "bearish" && supportLevel !== null && Number.isFinite(supportLevel)
        ? ((close - supportLevel) / close) * 100
        : null;
  const higherTimeframeRoomPass = roomPct === null || roomPct >= 1;
  const higherTimeframeContextPresent = direction === "bullish" ? max3M !== null && max1Y !== null : min3M !== null && min1Y !== null;

  const checkDiagnostics: Stage3CheckDiagnostic[] = [
    { check: "alignment", pass: alignmentPass, reason: alignmentReason },
    { check: "expansion", pass: expansionPass, reason: `expansionRatio=${expansionRatio === null ? "n/a" : expansionRatio.toFixed(2)}` },
    { check: "body-wick", pass: bodyQualityPass, reason: `bodyToRange=${bodyToRange.toFixed(2)}, closeLocation=${closeLocation.toFixed(2)}, wickiness=${wickiness === null ? "n/a" : wickiness.toFixed(2)}` },
    {
      check: "volume",
      pass: volumePass,
      reason:
        volumeRatio === null
          ? `volume ratio unavailable (lastVolume=${lastVolume ?? "n/a"}, priorVolumeBarsWithData=${priorVolumeCount})`
          : `volumeRatio=${volumeRatio.toFixed(2)} using lastVolume=${lastVolume} / avgVolume=${averageVolume?.toFixed(2)}`,
    },
    {
      check: "volume-data",
      pass: volumeDataPresent,
      reason: volumeDataPresent ? "volume values parsed from at least one 1D bar" : "missing volume data in 1D bars",
    },
    { check: "choppy", pass: choppyPass, reason: `flipCount=${flipCount}` },
    { check: "continuation", pass: continuationPass, reason: direction === "bullish" ? `close=${close.toFixed(2)} vs prevHigh=${prevHigh?.toFixed(2) ?? "n/a"}` : `close=${close.toFixed(2)} vs prevLow=${prevLow?.toFixed(2) ?? "n/a"}` },
    {
      check: "higher-timeframe-context",
      pass: higherTimeframeContextPresent,
      reason: higherTimeframeContextPresent ? "3M/1Y highs/lows available" : "missing higher-timeframe context (3M/1Y high/low data)",
    },
    { check: "higher-timeframe-room", pass: higherTimeframeRoomPass, reason: `roomPct=${roomPct === null ? "n/a" : roomPct.toFixed(2)}%` },
  ];

  const checks = [expansionPass, bodyQualityPass, volumePass, choppyPass, continuationPass, higherTimeframeRoomPass];
  const passedChecks = checks.filter(Boolean).length;
  const pass = passedChecks >= 4 && continuationPass;

  const detailParts = [
    `expansion ${expansionPass ? "ok" : "weak"}`,
    `body/wick ${bodyQualityPass ? "clean" : "messy"}`,
    `volume ${volumePass ? "supports" : "light"}`,
    `chop ${choppyPass ? "contained" : "high"}`,
    `continuation ${continuationPass ? "yes" : "rejection risk"}`,
    `HTF room ${higherTimeframeRoomPass ? "adequate" : "limited"}`,
  ];

  return {
    pass,
    direction,
    movePct: move1D,
    volumeRatio,
    score: passedChecks,
    summary: detailParts.join(", "),
    diagnostics: {
      timeframeDiagnostics,
      move1D,
      move1W,
      bias1D: dayBias,
      bias1W: weekBias,
      alignmentRule,
      alignmentPass,
      alignmentReason,
      candleBodySize: body,
      candleRange: range,
      bodyToRange,
      wickiness,
      closeLocation,
      volumeDataPresent,
      lastVolume,
      priorVolumeBarsWithData: priorVolumeCount,
      averageVolume,
      volumeRatioComputation:
        volumeRatio === null
          ? `unable to compute (lastVolume=${lastVolume ?? "n/a"}, averageVolume=${averageVolume === null ? "n/a" : averageVolume.toFixed(2)})`
          : `${lastVolume} / ${averageVolume?.toFixed(2)} = ${volumeRatio.toFixed(2)}`,
      resistanceLevel: resistanceLevel !== null && Number.isFinite(resistanceLevel) ? resistanceLevel : null,
      supportLevel: supportLevel !== null && Number.isFinite(supportLevel) ? supportLevel : null,
      roomPct,
      checks: checkDiagnostics,
    },
  };
}

export function runFakeScan(input: ScanInput): ScanResult {
  const promptLower = input.prompt.toLowerCase();
  const excluded = input.excludedTickers ?? [];

  if (promptLower.includes("bullish")) {
    const ticker = pickTicker(["AAPL", "MSFT"], excluded);

    if (!ticker) {
      return {
        ticker: null,
        direction: null,
        confidence: null,
        conclusion: "no_trade_today",
        reason: "Bullish prompt detected, but all mock bullish tickers are excluded.",
      };
    }

    return {
      ticker,
      direction: "bullish",
      confidence: getFakeConfidence("bullish"),
      conclusion: "confirmed",
      reason: "Mock bullish signal matched your prompt.",
    };
  }

  if (promptLower.includes("bearish")) {
    const ticker = pickTicker(["NVDA", "META"], excluded);

    if (!ticker) {
      return {
        ticker: null,
        direction: null,
        confidence: null,
        conclusion: "no_trade_today",
        reason: "Bearish prompt detected, but all mock bearish tickers are excluded.",
      };
    }

    return {
      ticker,
      direction: "bearish",
      confidence: getFakeConfidence("bearish"),
      conclusion: "confirmed",
      reason: "Mock bearish signal matched your prompt.",
    };
  }

  return {
    ticker: null,
    direction: null,
    confidence: null,
    conclusion: "no_trade_today",
    reason: "No bullish or bearish keyword found in prompt.",
  };
}

function parseBars(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  const directBars = objectPayload["Bars"];
  if (Array.isArray(directBars)) {
    return directBars.filter((bar): bar is Record<string, unknown> => !!bar && typeof bar === "object");
  }

  const barsEntry = Object.entries(objectPayload).find(([key]) => normalizeFieldName(key) === "bars");
  if (barsEntry && Array.isArray(barsEntry[1])) {
    return barsEntry[1].filter((bar): bar is Record<string, unknown> => !!bar && typeof bar === "object");
  }

  const nestedData = objectPayload["Data"];
  if (nestedData && typeof nestedData === "object") {
    return parseBars(nestedData);
  }

  return [];
}

function normalizeFieldName(field: string): string {
  return field.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function normalizeBar(bar: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...bar };
  const fieldAliasMap: Record<string, string[]> = {
    Open: ["open"],
    High: ["high"],
    Low: ["low"],
    Close: ["close", "last"],
    Volume: ["volume", "vol", "totalvolume", "totalvolumetraded", "tradevolume"],
  };

  for (const [targetField, aliases] of Object.entries(fieldAliasMap)) {
    if (readNumber(normalized, [targetField]) !== null) {
      continue;
    }

    const matchedEntry = Object.entries(bar).find(([key]) => aliases.includes(normalizeFieldName(key)));
    if (!matchedEntry) {
      continue;
    }

    normalized[targetField] = matchedEntry[1];
  }

  return normalized;
}

function getDte(expirationDate: Date): number {
  const now = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((expirationDate.getTime() - now.getTime()) / msPerDay);
}

function readExpirations(payload: unknown): { date: string; dte: number; apiValue: string }[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  const rawExpirations = objectPayload["Expirations"];
  if (!Array.isArray(rawExpirations)) {
    return [];
  }

  const results: { date: string; dte: number; apiValue: string }[] = [];

  for (const entry of rawExpirations) {
    let dateText: string | null = null;
    if (typeof entry === "string") {
      dateText = entry;
    } else if (entry && typeof entry === "object") {
      const dateValue = (entry as Record<string, unknown>)["Date"];
      if (typeof dateValue === "string") {
        dateText = dateValue;
      }
    }

    if (!dateText) {
      continue;
    }

    const expirationDate = new Date(dateText);
    if (Number.isNaN(expirationDate.getTime())) {
      continue;
    }

    const dte = getDte(expirationDate);
    if (dte > 0) {
      results.push({ date: expirationDate.toISOString().slice(0, 10), dte, apiValue: dateText });
    }
  }

  return results;
}

function parseContracts(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  const keys = ["Options", "OptionChain", "Contracts", "Calls", "Puts", "Strikes"];
  for (const key of keys) {
    const value = objectPayload[key];
    if (Array.isArray(value)) {
      return value.filter((contract): contract is Record<string, unknown> => !!contract && typeof contract === "object");
    }
  }

  return [];
}

function readText(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function readNumericStrikeValues(value: unknown): number[] {
  if (typeof value === "number") {
    return Number.isFinite(value) ? [value] : [];
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? [parsed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => readNumericStrikeValues(entry));
  }

  return [];
}

function readStrikes(payload: unknown): { strikes: StrikeCandidate[]; rawStrikeCount: number; normalizedStrikeCount: number } {
  if (!payload || typeof payload !== "object") {
    return { strikes: [], rawStrikeCount: 0, normalizedStrikeCount: 0 };
  }

  const objectPayload = payload as Record<string, unknown>;
  const rawStrikes = objectPayload["Strikes"];
  if (Array.isArray(rawStrikes)) {
    const numericStrikes = readNumericStrikeValues(rawStrikes);
    const deduped = [...new Set(numericStrikes)].sort((a, b) => a - b);

    return {
      strikes: deduped.map((strike) => ({ strike, callSymbol: null, putSymbol: null })),
      rawStrikeCount: rawStrikes.length,
      normalizedStrikeCount: deduped.length,
    };
  }

  const contracts = parseContracts(payload);
  if (contracts.length === 0) {
    return { strikes: [], rawStrikeCount: 0, normalizedStrikeCount: 0 };
  }

  const results: StrikeCandidate[] = [];
  for (const contract of contracts) {
    const strike = readNumber(contract, ["Strike", "StrikePrice", "Price"]);
    if (strike === null) {
      continue;
    }

    const callSymbol = readText(contract, ["CallSymbol", "Call", "OptionSymbol", "Symbol"]);
    const putSymbol = readText(contract, ["PutSymbol", "Put"]);
    results.push({ strike, callSymbol, putSymbol });
  }

  const deduped = new Map<number, StrikeCandidate>();
  for (const strikeEntry of results) {
    if (!deduped.has(strikeEntry.strike)) {
      deduped.set(strikeEntry.strike, strikeEntry);
      continue;
    }

    const existing = deduped.get(strikeEntry.strike);
    if (!existing) {
      continue;
    }

    deduped.set(strikeEntry.strike, {
      strike: strikeEntry.strike,
      callSymbol: existing.callSymbol ?? strikeEntry.callSymbol,
      putSymbol: existing.putSymbol ?? strikeEntry.putSymbol,
    });
  }

  return {
    strikes: [...deduped.values()].sort((a, b) => a.strike - b.strike),
    rawStrikeCount: contracts.length,
    normalizedStrikeCount: deduped.size,
  };
}

function buildOptionSymbol(symbol: string, expirationDate: string, type: "C" | "P", strike: number): string {
  const [yearText, monthText, dayText] = expirationDate.split("-");
  const yearShort = yearText?.slice(-2) ?? "00";
  const month = monthText ?? "01";
  const day = dayText ?? "01";
  const strikeText = Number.isInteger(strike)
    ? strike.toString()
    : strike.toFixed(3).replace(/\.?0+$/, "");
  return `${symbol} ${yearShort}${month}${day}${type}${strikeText}`;
}

async function runStage2OptionsTradability(
  get: (path: string) => Promise<Response>,
  stage1Passed: Stage1Candidate[],
): Promise<{ passed: OptionsCandidate[]; diagnostics: Stage2SymbolDiagnostic[] }> {
  const stage2Passed: OptionsCandidate[] = [];
  const diagnostics: Stage2SymbolDiagnostic[] = [];

  for (const candidate of stage1Passed) {
    const diagnostic: Stage2SymbolDiagnostic = {
      symbol: candidate.symbol,
      underlyingQuoteRequestTarget: null,
      underlyingQuoteStatus: null,
      underlyingPriceFieldCandidates: [],
      underlyingPriceFieldUsed: null,
      underlyingPrice: null,
      underlyingPriceFallback: null,
      expirationsFound: false,
      rawStrikeCount: null,
      normalizedStrikeCount: null,
      selectedExpiration: null,
      selectedDte: null,
      selectedExpirationApiValue: null,
      selectedStrike: null,
      evaluatedContract: null,
      bid: null,
      ask: null,
      spreadWidth: null,
      spreadPercent: null,
      openInterest: null,
      optionQuoteAttempts: [],
      pass: false,
      reason: "Not evaluated.",
    };

    const quotePath = `/marketdata/quotes/${encodeURIComponent(candidate.symbol)}`;
    diagnostic.underlyingQuoteRequestTarget = quotePath;
    const underlyingQuoteResponse = await get(quotePath);
    diagnostic.underlyingQuoteStatus = underlyingQuoteResponse.status;

    const underlyingPriceFields = ["Last", "LastTrade", "Trade", "Mark", "Close"];
    let underlyingPrice = candidate.lastPrice;

    if (underlyingQuoteResponse.ok) {
      const underlyingQuotePayload = await underlyingQuoteResponse.json();
      const underlyingQuote = pickFirstQuote(underlyingQuotePayload);
      let selectedField: string | null = null;

      for (const field of underlyingPriceFields) {
        const rawValue = underlyingQuote ? underlyingQuote[field] : null;
        const parsedValue = readNumber(underlyingQuote, [field]);
        diagnostic.underlyingPriceFieldCandidates.push({
          field,
          rawValue: typeof rawValue === "number" || typeof rawValue === "string" ? rawValue : null,
          parsedValue,
        });

        if (selectedField === null && parsedValue !== null) {
          selectedField = field;
          underlyingPrice = parsedValue;
        }
      }

      diagnostic.underlyingPriceFieldUsed = selectedField;
      if (selectedField === null) {
        diagnostic.underlyingPriceFallback = "No preferred quote field parsed; fell back to Stage 1 lastPrice.";
      }
    } else {
      diagnostic.underlyingPriceFallback = "Underlying quote request failed; fell back to Stage 1 lastPrice.";
    }

    diagnostic.underlyingPrice = Number.isFinite(underlyingPrice) && underlyingPrice > 0 ? underlyingPrice : null;
    if (diagnostic.underlyingPrice === null) {
      diagnostic.reason = "Unable to resolve underlying price for strike selection.";
      diagnostics.push(diagnostic);
      continue;
    }

    const underlyingPriceForStrikeSelection = diagnostic.underlyingPrice;

    const expirationsResponse = await get(`/marketdata/options/expirations/${encodeURIComponent(candidate.symbol)}`);
    if (!expirationsResponse.ok) {
      diagnostic.reason = `Expirations request failed (${expirationsResponse.status}).`;
      diagnostics.push(diagnostic);
      continue;
    }

    const expirationsPayload = await expirationsResponse.json();
    const expirations = readExpirations(expirationsPayload);
    diagnostic.expirationsFound = expirations.length > 0;
    if (expirations.length === 0) {
      diagnostic.reason = "No valid future expirations found.";
      diagnostics.push(diagnostic);
      continue;
    }

    const inRange = expirations.filter((item) => item.dte >= 14 && item.dte <= 21);
    const targetExpiration = (inRange.length > 0 ? inRange : expirations).sort(
      (a, b) => Math.abs(a.dte - 17) - Math.abs(b.dte - 17),
    )[0];

    if (!targetExpiration) {
      diagnostic.reason = "Unable to pick target expiration.";
      diagnostics.push(diagnostic);
      continue;
    }

    diagnostic.selectedExpiration = targetExpiration.date;
    diagnostic.selectedDte = targetExpiration.dte;
    diagnostic.selectedExpirationApiValue = targetExpiration.apiValue;

    const strikesPath = `/marketdata/options/strikes/${encodeURIComponent(candidate.symbol)}?expiration=${encodeURIComponent(targetExpiration.apiValue)}`;
    const strikesResponse = await get(strikesPath);
    if (!strikesResponse.ok) {
      diagnostic.reason = `Strikes request failed (${strikesResponse.status}).`;
      diagnostics.push(diagnostic);
      continue;
    }

    const strikesPayload = await strikesResponse.json();
    const { strikes, rawStrikeCount, normalizedStrikeCount } = readStrikes(strikesPayload);
    diagnostic.rawStrikeCount = rawStrikeCount;
    diagnostic.normalizedStrikeCount = normalizedStrikeCount;
    if (strikes.length === 0) {
      diagnostic.reason = "No usable strikes returned for target expiration.";
      diagnostics.push(diagnostic);
      continue;
    }

    const selectedStrike = [...strikes].sort(
      (a, b) => Math.abs(a.strike - underlyingPriceForStrikeSelection) - Math.abs(b.strike - underlyingPriceForStrikeSelection),
    )[0];

    if (!selectedStrike) {
      diagnostic.reason = "Unable to select strike near underlying price.";
      diagnostics.push(diagnostic);
      continue;
    }

    diagnostic.selectedStrike = selectedStrike.strike;

    const symbolsToTry = [
      selectedStrike.callSymbol,
      selectedStrike.putSymbol,
      buildOptionSymbol(candidate.symbol, targetExpiration.date, "C", selectedStrike.strike),
      buildOptionSymbol(candidate.symbol, targetExpiration.date, "P", selectedStrike.strike),
    ].filter((item, index, list): item is string => {
      if (typeof item !== "string" || item.trim().length === 0) {
        return false;
      }

      return list.indexOf(item) === index;
    });

    let quoteData: { optionSymbol: string; openInterest: number; spread: number; mid: number; bid: number; ask: number } | null = null;
    let capturedFirstHttp200Payload = false;
    for (const optionSymbol of symbolsToTry) {
      const requestTarget = `/marketdata/quotes/${encodeURIComponent(optionSymbol)}`;
      const optionQuoteResponse = await get(requestTarget);
      if (!optionQuoteResponse.ok) {
        diagnostic.optionQuoteAttempts.push({
          optionSymbol,
          requestTarget,
          status: optionQuoteResponse.status,
          rawQuotePayloadSample: null,
          parsedBid: null,
          parsedAsk: null,
          parsedOpenInterest: null,
          spreadWidth: null,
          spreadPercent: null,
          outcome: "HTTP request failed.",
        });
        continue;
      }

      const optionQuotePayload = await optionQuoteResponse.json();
      const optionQuote = pickFirstQuote(optionQuotePayload);
      const openInterest = readNumber(optionQuote, [
        "OpenInterest",
        "DailyOpenInterest",
        "OpenInt",
        "OI",
        "Open_Int",
        "OpenInterestToday",
      ]);
      const bid = readNumber(optionQuote, ["Bid", "BidPrice", "BestBid", "BidPx"]);
      const ask = readNumber(optionQuote, ["Ask", "AskPrice", "BestAsk", "AskPx"]);
      const mid = bid !== null && ask !== null ? (ask + bid) / 2 : null;
      const spread = bid !== null && ask !== null ? ask - bid : null;
      const spreadPct = spread !== null && mid !== null && mid > 0 ? spread / mid : null;
      const rawQuotePayloadSample = !capturedFirstHttp200Payload && optionQuote
        ? optionQuote
        : null;

      if (!capturedFirstHttp200Payload && optionQuote) {
        capturedFirstHttp200Payload = true;
      }

      let parseFailureReason: string | null = null;
      if (openInterest === null) {
        parseFailureReason = "missing open interest";
      } else if (bid === null) {
        parseFailureReason = "missing bid";
      } else if (ask === null) {
        parseFailureReason = "missing ask";
      } else if (bid <= 0) {
        parseFailureReason = "invalid bid (<= 0)";
      } else if (ask <= bid) {
        parseFailureReason = "invalid spread (ask <= bid)";
      }

      if (parseFailureReason !== null) {
        diagnostic.optionQuoteAttempts.push({
          optionSymbol,
          requestTarget,
          status: optionQuoteResponse.status,
          rawQuotePayloadSample,
          parsedBid: bid,
          parsedAsk: ask,
          parsedOpenInterest: openInterest,
          spreadWidth: spread,
          spreadPercent: spreadPct,
          outcome: `Quote payload unusable: ${parseFailureReason}.`,
        });
        continue;
      }

      const parsedOpenInterest = openInterest as number;
      const parsedBid = bid as number;
      const parsedAsk = ask as number;
      quoteData = {
        optionSymbol,
        openInterest: parsedOpenInterest,
        spread: parsedAsk - parsedBid,
        mid: (parsedAsk + parsedBid) / 2,
        bid: parsedBid,
        ask: parsedAsk,
      };
      diagnostic.optionQuoteAttempts.push({
        optionSymbol,
        requestTarget,
        status: optionQuoteResponse.status,
        rawQuotePayloadSample,
        parsedBid: bid,
        parsedAsk: ask,
        parsedOpenInterest: openInterest,
        spreadWidth: spread,
        spreadPercent: spreadPct,
        outcome: "Usable quote payload found.",
      });
      break;
    }

    if (!quoteData) {
      diagnostic.reason = "No usable direct option quote found for selected strike.";
      diagnostics.push(diagnostic);
      continue;
    }

    const spreadPct = quoteData.mid > 0 ? quoteData.spread / quoteData.mid : Number.POSITIVE_INFINITY;
    const hasTightSpread = quoteData.spread <= 1.5 && spreadPct <= 0.12;
    if (quoteData.openInterest <= 500) {
      diagnostic.evaluatedContract = quoteData.optionSymbol;
      diagnostic.bid = quoteData.bid;
      diagnostic.ask = quoteData.ask;
      diagnostic.spreadWidth = quoteData.spread;
      diagnostic.spreadPercent = spreadPct;
      diagnostic.openInterest = quoteData.openInterest;
      diagnostic.reason = "Candidate contract failed OI threshold (requires > 500).";
      diagnostics.push(diagnostic);
      continue;
    }

    if (!hasTightSpread) {
      diagnostic.evaluatedContract = quoteData.optionSymbol;
      diagnostic.bid = quoteData.bid;
      diagnostic.ask = quoteData.ask;
      diagnostic.spreadWidth = quoteData.spread;
      diagnostic.spreadPercent = spreadPct;
      diagnostic.openInterest = quoteData.openInterest;
      diagnostic.reason = "Candidate contract failed spread threshold (requires <= 1.5 and <= 12% of mid).";
      diagnostics.push(diagnostic);
      continue;
    }

    diagnostic.evaluatedContract = quoteData.optionSymbol;
    diagnostic.bid = quoteData.bid;
    diagnostic.ask = quoteData.ask;
    diagnostic.spreadWidth = quoteData.spread;
    diagnostic.spreadPercent = spreadPct;
    diagnostic.openInterest = quoteData.openInterest;
    diagnostic.pass = true;
    diagnostic.reason = "Passed Stage 2 filters.";

    stage2Passed.push({
      ...candidate,
      targetExpiration: targetExpiration.date,
      targetDte: targetExpiration.dte,
      optionOpenInterest: quoteData.openInterest,
      optionSpread: quoteData.spread,
      optionMid: quoteData.mid,
    });
    diagnostics.push(diagnostic);
  }

  return { passed: stage2Passed, diagnostics };
}

async function runStarterUniverseTradeStationScan(input: ScanInput): Promise<ScanResult> {
  const get = await createTradeStationGetFetcher();
  const excludedSet = new Set((input.excludedTickers ?? []).map((item) => item.toUpperCase()));
  const stage1Entered = V1_SCAN_UNIVERSE.filter((symbol) => !excludedSet.has(symbol));
  logGeneralScanDebug("Stage 1 entered", stage1Entered);

  // Stage 1: basic stock filters
  const stage1Passed: Stage1Candidate[] = [];
  for (const symbol of V1_SCAN_UNIVERSE) {
    if (excludedSet.has(symbol)) {
      continue;
    }

    const quoteResponse = await get(`/marketdata/quotes/${encodeURIComponent(symbol)}`);
    if (!quoteResponse.ok) {
      continue;
    }

    const quotePayload = await quoteResponse.json();
    const quote = pickFirstQuote(quotePayload);
    const lastPrice = readNumber(quote, ["Last", "LastTrade", "Trade", "Close"]);
    const averageVolume = readNumber(quote, ["AverageVolume", "AverageDailyVolume", "AvgVolume", "Volume"]);

    if (lastPrice === null || lastPrice < 10 || lastPrice > 500) {
      continue;
    }

    if (averageVolume !== null && averageVolume <= 1_000_000) {
      continue;
    }

    stage1Passed.push({ symbol, lastPrice, averageVolume });
  }

  logGeneralScanDebug(
    "Stage 1 passed",
    stage1Passed.map((candidate) => candidate.symbol),
  );

  if (stage1Passed.length === 0) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: "No symbols passed Stage 1 stock filters in the V1 scan universe.",
    };
  }

  // Stage 2: options tradability filters
  const { passed: stage2Passed, diagnostics: stage2Diagnostics } = await runStage2OptionsTradability(get, stage1Passed);
  logStage2Diagnostics(stage2Diagnostics);

  logGeneralScanDebug(
    "Stage 2 passed",
    stage2Passed.map((candidate) => candidate.symbol),
  );

  if (stage2Passed.length === 0) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: "No symbols passed Stage 2 options tradability filters.",
    };
  }

  // Stage 3: multi-timeframe bar/candlestick + volume review
  const stage3Passed: ChartCandidate[] = [];
  for (const candidate of stage2Passed) {
    const { barsByView: multiTimeframeBars, timeframeDiagnostics } = await loadMultiTimeframeBars(get, candidate.symbol);
    if (!multiTimeframeBars) {
      continue;
    }

    const review = runStage3ChartReview(multiTimeframeBars, timeframeDiagnostics);
    if (!review.pass || !review.direction) {
      continue;
    }

    stage3Passed.push({
      ...candidate,
      chartDirection: review.direction,
      chartMovePct: review.movePct,
      volumeRatio: review.volumeRatio,
      chartReviewSummary: review.summary,
      chartReviewScore: review.score,
      chartDiagnostics: review.diagnostics,
    });
  }

  logGeneralScanDebug(
    "Stage 3 passed",
    stage3Passed.map((candidate) => candidate.symbol),
  );

  if (stage3Passed.length === 0) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: "No symbols passed Stage 3 chart/bar review.",
    };
  }

  // Stage 4: simple final score and pick
  const { ranked, debug: finalRankingDebug } = buildFinalRanking(stage3Passed);
  logFinalRankingDebugSection(finalRankingDebug);

  const best = ranked[0];
  if (!best) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: "No final candidate was available after scoring.",
    };
  }

  const confidence: ScanConfidence = best.score >= 14 ? "85-92" : best.score >= 10 ? "75-84" : "65-74";
  logGeneralScanDebug("Final selected", [best.symbol]);

  return {
    ticker: best.symbol,
    direction: best.chartDirection,
    confidence,
    conclusion: "confirmed",
    reason: `Passed 4-stage scan: price/volume, options (${best.targetDte} DTE, OI ${Math.round(best.optionOpenInterest)}), Stage 3 ${best.chartDirection} review (${best.chartReviewSummary}).`,
  };
}

export async function runStage2DebugForStarterUniverse(): Promise<Stage2SymbolDiagnostic[]> {
  const get = await createTradeStationGetFetcher();
  const stage1Candidates: Stage1Candidate[] = V1_SCAN_UNIVERSE.map((symbol) => ({
    symbol,
    lastPrice: 1,
    averageVolume: null,
  }));
  const { diagnostics } = await runStage2OptionsTradability(get, stage1Candidates);
  return diagnostics;
}

export async function runStarterUniverseTelemetryDebug(): Promise<StarterUniverseTelemetry> {
  const get = await createTradeStationGetFetcher();
  const stage1RejectionSummary: StageFailureSummary = {};
  const stage2RejectionSummary: StageFailureSummary = {};
  const stage3RejectionSummary: StageFailureSummary = {};

  const stage1Entered = [...V1_SCAN_UNIVERSE];
  const stage1Passed: Stage1Candidate[] = [];
  for (const symbol of stage1Entered) {
    const quoteResponse = await get(`/marketdata/quotes/${encodeURIComponent(symbol)}`);
    if (!quoteResponse.ok) {
      incrementSummary(stage1RejectionSummary, "quote");
      continue;
    }

    const quotePayload = await quoteResponse.json();
    const quote = pickFirstQuote(quotePayload);
    const lastPrice = readNumber(quote, ["Last", "LastTrade", "Trade", "Close"]);
    const averageVolume = readNumber(quote, ["AverageVolume", "AverageDailyVolume", "AvgVolume", "Volume"]);

    if (lastPrice === null || lastPrice < 10 || lastPrice > 500) {
      incrementSummary(stage1RejectionSummary, "price");
      continue;
    }

    if (averageVolume !== null && averageVolume <= 1_000_000) {
      incrementSummary(stage1RejectionSummary, "volume");
      continue;
    }

    stage1Passed.push({ symbol, lastPrice, averageVolume });
  }

  const { passed: stage2Passed, diagnostics: stage2Diagnostics } = await runStage2OptionsTradability(get, stage1Passed);
  for (const item of stage2Diagnostics) {
    if (!item.pass) {
      incrementSummary(stage2RejectionSummary, categorizeStage2Failure(item.reason));
    }
  }

  const stage3Passed: ChartCandidate[] = [];
  const stage3NearMissCandidates: Stage3NearMiss[] = [];
  for (const candidate of stage2Passed) {
    const { barsByView: multiTimeframeBars, timeframeDiagnostics } = await loadMultiTimeframeBars(get, candidate.symbol);
    if (!multiTimeframeBars) {
      incrementSummary(stage3RejectionSummary, "other");
      stage3NearMissCandidates.push({
        symbol: candidate.symbol,
        direction: "none",
        score: 0,
        failReasons: ["other"],
      });
      continue;
    }

    const review = runStage3ChartReview(multiTimeframeBars, timeframeDiagnostics);
    if (!review.pass || !review.direction) {
      const failReasons = getStage3FailReasons(review);
      for (const failReason of failReasons) {
        incrementSummary(stage3RejectionSummary, failReason);
      }
      stage3NearMissCandidates.push({
        symbol: candidate.symbol,
        direction: review.direction ?? "none",
        score: review.score,
        failReasons,
      });
      continue;
    }

    stage3Passed.push({
      ...candidate,
      chartDirection: review.direction,
      chartMovePct: review.movePct,
      volumeRatio: review.volumeRatio,
      chartReviewSummary: review.summary,
      chartReviewScore: review.score,
      chartDiagnostics: review.diagnostics,
    });
  }

  const { ranked, debug: finalRankingDebug } = buildFinalRanking(stage3Passed);

  const nearMisses = stage3NearMissCandidates.sort((a, b) => b.score - a.score).slice(0, 3);

  return {
    stageCounts: {
      stage1Entered: stage1Entered.length,
      stage1Passed: stage1Passed.length,
      stage2Passed: stage2Passed.length,
      stage3Passed: stage3Passed.length,
      finalRanking: ranked.length,
    },
    stageSymbols: {
      stage1Entered,
      stage1Passed: stage1Passed.map((candidate) => candidate.symbol),
      stage2Passed: stage2Passed.map((candidate) => candidate.symbol),
      stage3Passed: stage3Passed.map((candidate) => candidate.symbol),
      finalRanking: ranked.map((candidate) => candidate.symbol),
    },
    stage3PassedDetails: ranked.map((candidate) => ({
      symbol: candidate.symbol,
      direction: candidate.chartDirection,
      score: candidate.score,
      summary: candidate.chartReviewSummary,
      whyPassed: summarizePassingChecks(candidate.chartDiagnostics.checks),
    })),
    finalRankingDebug,
    rejectionSummaries: {
      stage1: stage1RejectionSummary,
      stage2: stage2RejectionSummary,
      stage3: stage3RejectionSummary,
    },
    nearMisses,
    finalSelectedSymbol: ranked[0]?.symbol ?? null,
  };
}

export async function runStage3DebugForStarterUniverse(): Promise<
  { symbol: string; pass: boolean; direction: ScanDirection | null; movePct: number; volumeRatio: number | null; score: number; summary: string; diagnostics: Stage3Diagnostics }[]
> {
  const get = await createTradeStationGetFetcher();
  const results: { symbol: string; pass: boolean; direction: ScanDirection | null; movePct: number; volumeRatio: number | null; score: number; summary: string; diagnostics: Stage3Diagnostics }[] = [];

  for (const symbol of V1_SCAN_UNIVERSE) {
    const { barsByView: bars, timeframeDiagnostics } = await loadMultiTimeframeBars(get, symbol);
    if (!bars) {
      results.push({
        symbol,
        pass: false,
        direction: null,
        movePct: 0,
        volumeRatio: null,
        score: 0,
        summary: "failed to load required multi-timeframe bars",
        diagnostics: {
          timeframeDiagnostics,
          move1D: null,
          move1W: null,
          bias1D: "neutral",
          bias1W: "neutral",
          alignmentRule: "bullish requires 1D move >= +0.5% and 1W move >= 0%; bearish requires 1D move <= -0.5% and 1W move <= 0%",
          alignmentPass: false,
          alignmentReason: "failed to load required multi-timeframe bars",
          candleBodySize: null,
          candleRange: null,
          bodyToRange: null,
          wickiness: null,
          closeLocation: null,
          volumeDataPresent: false,
          lastVolume: null,
          priorVolumeBarsWithData: 0,
          averageVolume: null,
          volumeRatioComputation: "volumeRatio requires both lastVolume and averageVolume > 0",
          resistanceLevel: null,
          supportLevel: null,
          roomPct: null,
          checks: [{ check: "bars-load", pass: false, reason: "failed to load required multi-timeframe bars" }],
        },
      });
      continue;
    }

    const review = runStage3ChartReview(bars, timeframeDiagnostics);
    results.push({ symbol, ...review });
  }

  return results;
}

function parseSingleSymbolPrompt(prompt: string): SymbolPromptMatch | null {
  const matched = prompt.match(/(?:^|\s)(analyze|review|scan)\s+\$?([A-Za-z]{1,5})(?=\s|$|[,.!?;:])/i);

  if (!matched) {
    return null;
  }

  const actionRaw = matched[1];
  const symbolRaw = matched[2];
  if (!actionRaw || !symbolRaw) {
    return null;
  }

  const symbol = symbolRaw.toUpperCase();
  const isUppercaseTickerStyle = symbolRaw === symbol;
  const looksLikeTicker = /^[A-Z]{1,5}$/.test(symbol);
  if (!isUppercaseTickerStyle || !looksLikeTicker || NON_TICKER_TOKENS.has(symbol)) {
    return null;
  }

  return {
    action: actionRaw.toLowerCase() as SymbolPromptMatch["action"],
    symbol,
  };
}

function pickFirstQuote(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (Array.isArray(payload)) {
    return (payload[0] as Record<string, unknown>) ?? null;
  }

  const objectPayload = payload as Record<string, unknown>;
  const quotes = objectPayload["Quotes"];
  if (Array.isArray(quotes)) {
    return (quotes[0] as Record<string, unknown>) ?? null;
  }

  if (quotes && typeof quotes === "object") {
    return quotes as Record<string, unknown>;
  }

  const quote = objectPayload["Quote"];
  if (quote && typeof quote === "object") {
    return quote as Record<string, unknown>;
  }

  const data = objectPayload["Data"];
  if (data && typeof data === "object") {
    return pickFirstQuote(data);
  }

  return objectPayload;
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
      const normalized = value.trim().replace(/,/g, "");
      const parsed = Number(normalized);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    const normalizedKey = normalizeFieldName(key);
    const caseInsensitiveMatch = Object.entries(source).find(([sourceKey]) => normalizeFieldName(sourceKey) === normalizedKey);
    if (!caseInsensitiveMatch) {
      continue;
    }

    const [, fallbackValue] = caseInsensitiveMatch;
    if (typeof fallbackValue === "number" && Number.isFinite(fallbackValue)) {
      return fallbackValue;
    }
    if (typeof fallbackValue === "string") {
      const normalizedFallback = fallbackValue.trim().replace(/,/g, "");
      const parsedFallback = Number(normalizedFallback);
      if (Number.isFinite(parsedFallback)) {
        return parsedFallback;
      }
    }
  }

  return null;
}

async function fetchRecentCloseChange(get: (path: string) => Promise<Response>, symbol: string): Promise<number | null> {
  const response = await get(
    `/marketdata/barcharts/${encodeURIComponent(symbol)}?interval=5&unit=Minute&barsback=5`,
  );

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const bars = payload["Bars"];
  if (!Array.isArray(bars) || bars.length < 2) {
    return null;
  }

  const firstClose = readNumber(bars[0] as Record<string, unknown>, ["Close"]);
  const lastClose = readNumber(bars[bars.length - 1] as Record<string, unknown>, ["Close"]);

  if (firstClose === null || lastClose === null || firstClose === 0) {
    return null;
  }

  return ((lastClose - firstClose) / firstClose) * 100;
}

async function runSingleSymbolTradeStationAnalysis(symbol: string): Promise<ScanResult> {
  const get = await createTradeStationGetFetcher();
  const { barsByView: bars, timeframeDiagnostics } = await loadMultiTimeframeBars(get, symbol);
  if (bars) {
    const review = runStage3ChartReview(bars, timeframeDiagnostics);
    if (review.pass && review.direction) {
      const confidence: ScanConfidence = review.score >= 5 ? "85-92" : review.score >= 4 ? "75-84" : "65-74";
      return {
        ticker: symbol,
        direction: review.direction,
        confidence,
        conclusion: "confirmed",
        reason: `Stage 3 ${review.direction} chart review passed (${review.summary}).`,
      };
    }

    return {
      ticker: symbol,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: `Stage 3 chart review did not pass (${review.summary}).`,
    };
  }

  const intradayBarChangePct = await fetchRecentCloseChange(get, symbol).catch(() => null);
  if (intradayBarChangePct !== null && intradayBarChangePct > 0.2) {
    return {
      ticker: symbol,
      direction: "bullish",
      confidence: "65-74",
      conclusion: "confirmed",
      reason: `Recent intraday bars are trending up (${intradayBarChangePct.toFixed(2)}% over recent bars).`,
    };
  }

  if (intradayBarChangePct !== null && intradayBarChangePct < -0.2) {
    return {
      ticker: symbol,
      direction: "bearish",
      confidence: "65-74",
      conclusion: "confirmed",
      reason: `Recent intraday bars are trending down (${intradayBarChangePct.toFixed(2)}% over recent bars).`,
    };
  }

  return {
    ticker: symbol,
    direction: null,
    confidence: null,
    conclusion: "no_trade_today",
    reason: "Unable to confirm a clean Stage 3 chart setup.",
  };
}

export async function runScan(input: ScanInput): Promise<ScanResult> {
  const normalizedInput: ScanInput = {
    ...input,
    excludedTickers: input.excludedTickers ?? [],
  };

  const symbolMatch = parseSingleSymbolPrompt(normalizedInput.prompt);
  if (!symbolMatch) {
    const enforceStarterUniverse = (result: ScanResult): ScanResult => {
      if (!result.ticker || isStarterUniverseTicker(result.ticker)) {
        return result;
      }

      return {
        ticker: null,
        direction: null,
        confidence: null,
        conclusion: "no_trade_today",
        reason: `General scan mode is limited to the V1 scan universe (${V1_SCAN_UNIVERSE.join(", ")}).`,
      };
    };

    try {
      return enforceStarterUniverse(await runStarterUniverseTradeStationScan(normalizedInput));
    } catch {
      return enforceStarterUniverse(runFakeScan(normalizedInput));
    }
  }

  const excluded = new Set((normalizedInput.excludedTickers ?? []).map((item) => item.toUpperCase()));
  if (excluded.has(symbolMatch.symbol)) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: `${symbolMatch.symbol} is in excludedTickers.`,
    };
  }

  return runSingleSymbolTradeStationAnalysis(symbolMatch.symbol);
}
