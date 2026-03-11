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
const FINALIST_REVIEW_LIMIT = 3;
const FINAL_SCORE_TIE_TOLERANCE = 0.05;
const YAHOO_FINANCE_BASE_URL = "https://query1.finance.yahoo.com";

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
  optionQuoteAttempts: DirectOptionQuoteAttempt[];
  pass: boolean;
  reason: string;
};

export type OptionStrikeCandidate = {
  strike: number;
  callSymbol: string | null;
  putSymbol: string | null;
};

export type OptionExpirationCandidate = { date: string; dte: number; apiValue: string };

export type DirectOptionQuoteAttempt = {
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
};

export type DirectOptionQuoteData = {
  optionSymbol: string;
  openInterest: number;
  spread: number;
  mid: number;
  bid: number;
  ask: number;
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

type Stage3Evaluation = {
  symbol: string;
  pass: boolean;
  candidate: ChartCandidate | null;
  direction: ScanDirection | "none";
  reviewScore: number;
  summary: string;
  rejectionReason: string | null;
};

type FinalistReviewResult = {
  symbol: string;
  rankingScore: number;
  stage1Inputs: {
    lastPrice: number;
    averageVolume: number | null;
  } | null;
  stage2Inputs: {
    targetExpiration: string;
    targetDte: number;
    optionOpenInterest: number;
    optionSpread: number;
    optionMid: number;
  } | null;
  stage3Inputs: {
    direction: ScanDirection;
    movePct: number;
    volumeRatio: number | null;
    chartReviewScore: number;
    chartReviewSummary: string;
    structureChecks: string;
  } | null;
  conclusion: ScanResult["conclusion"];
  reason: string;
};

type EarningsCheckResult = {
  symbol: string;
  earningsDate: string | null;
  windowMinDte: number;
  windowMaxDte: number;
  pass: boolean;
  reason: string;
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
    .map((candidate, idx) => ({ ...candidate, score: scoreStage3Candidate(candidate), stableIdx: idx }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => compareRankedFinalists(a, b))
    .map(({ stableIdx, ...candidate }) => candidate);

  const topScore = ranked[0]?.score ?? null;
  for (const item of debug) {
    if (!item.enteredFinalRanking) {
      continue;
    }

    if (item.symbol === ranked[0]?.symbol) {
      item.selected = true;
      item.reason = "selected as top final score (with deterministic tie-breaks)";
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

function compareRankedFinalists(
  a: ChartCandidate & { score: number; stableIdx: number },
  b: ChartCandidate & { score: number; stableIdx: number },
): number {
  const scoreDelta = b.score - a.score;
  if (Math.abs(scoreDelta) > FINAL_SCORE_TIE_TOLERANCE) {
    return scoreDelta;
  }

  const reviewScoreDelta = b.chartReviewScore - a.chartReviewScore;
  if (reviewScoreDelta !== 0) {
    return reviewScoreDelta;
  }

  const moveDelta = Math.abs(b.chartMovePct) - Math.abs(a.chartMovePct);
  if (moveDelta !== 0) {
    return moveDelta;
  }

  const oiDelta = b.optionOpenInterest - a.optionOpenInterest;
  if (oiDelta !== 0) {
    return oiDelta;
  }

  const spreadDelta = a.optionSpread - b.optionSpread;
  if (spreadDelta !== 0) {
    return spreadDelta;
  }

  const symbolDelta = a.symbol.localeCompare(b.symbol);
  if (symbolDelta !== 0) {
    return symbolDelta;
  }

  return a.stableIdx - b.stableIdx;
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

function logStage3PassThroughDebugSection(
  stage3Evaluations: Stage3Evaluation[],
  finalRankingDebug: FinalRankingEntry[],
  rankingThreshold: number | null,
): void {
  if (process.env.SCANNER_DEBUG !== "1") {
    return;
  }

  console.log("[scanner:debug] Stage 3 pass-through and final selection:");
  const passCandidates = stage3Evaluations.filter((item) => item.pass);
  if (passCandidates.length === 0) {
    console.log("[scanner:debug] (no Stage 3 pass candidates)");
    return;
  }

  const finalRankingBySymbol = new Map(finalRankingDebug.map((item) => [item.symbol, item]));
  const thresholdLabel = rankingThreshold === null ? "n/a" : rankingThreshold.toFixed(2);
  for (const candidate of passCandidates) {
    const rankingEntry = finalRankingBySymbol.get(candidate.symbol);
    const enteredFinalRanking = rankingEntry?.enteredFinalRanking ?? false;
    const selected = rankingEntry?.selected ?? false;
    const rankingScore = rankingEntry?.score === null || rankingEntry?.score === undefined ? "n/a" : rankingEntry.score.toFixed(2);
    const reason = rankingEntry?.reason ?? "not evaluated in final ranking";

    console.log(
      `[scanner:debug] ${candidate.symbol}: stage3Pass=yes | enteredFinalRanking=${enteredFinalRanking ? "yes" : "no"} | rankingScore=${rankingScore} | rankingThreshold=${thresholdLabel} | selected=${selected ? "yes" : "no"} | reason=${reason}`,
    );
  }
}

function logFinalistReviewDebugSection(finalists: FinalistReviewResult[], selectedSymbol: string | null): void {
  if (process.env.SCANNER_DEBUG !== "1") {
    return;
  }

  console.log("[scanner:debug] Finalist confirmation review:");
  if (finalists.length === 0) {
    console.log("[scanner:debug] (no finalists available for review)");
    return;
  }

  for (const finalist of finalists) {
    const selected = selectedSymbol !== null && finalist.symbol === selectedSymbol ? "yes" : "no";
    const stageInputs = {
      stage1: finalist.stage1Inputs,
      stage2: finalist.stage2Inputs,
      stage3: finalist.stage3Inputs,
    };
    console.log(
      `[scanner:debug] ${finalist.symbol}: rankingScore=${finalist.rankingScore.toFixed(2)} | reviewConclusion=${finalist.conclusion} | selected=${selected} | reviewReason=${finalist.reason} | inputs=${JSON.stringify(stageInputs)}`,
    );
  }
}

function getSelectionWhyWonReason(finalists: FinalistReviewResult[], selectedSymbol: string): string {
  const selectedFinalist = finalists.find((item) => item.symbol === selectedSymbol);
  if (!selectedFinalist) {
    return `${selectedSymbol} was the first confirmed finalist in deterministic ranked order.`;
  }

  const outranked = finalists
    .filter((item) => item.symbol !== selectedSymbol)
    .map((item) => `${item.symbol} (${item.conclusion}, rank ${item.rankingScore.toFixed(2)})`)
    .join("; ");

  if (!outranked) {
    return `${selectedSymbol} was the only finalist in deterministic ranked order.`;
  }

  return `${selectedSymbol} won because finalists are reviewed in deterministic ranked order and it was the first confirmed symbol after higher-ranked outcomes (${outranked}).`;
}

async function evaluateStage3Candidates(
  get: (path: string) => Promise<Response>,
  stage2Passed: OptionsCandidate[],
): Promise<Stage3Evaluation[]> {
  const evaluations: Stage3Evaluation[] = [];

  for (const candidate of stage2Passed) {
    const { barsByView: multiTimeframeBars, timeframeDiagnostics } = await loadMultiTimeframeBars(get, candidate.symbol);
    if (!multiTimeframeBars) {
      evaluations.push({
        symbol: candidate.symbol,
        pass: false,
        candidate: null,
        direction: "none",
        reviewScore: 0,
        summary: "failed to load required multi-timeframe bars",
        rejectionReason: "other",
      });
      continue;
    }

    const review = runStage3ChartReview(multiTimeframeBars, timeframeDiagnostics);
    if (!review.pass || !review.direction) {
      const failReason = getStage3FailReasons(review)[0] ?? "other";
      evaluations.push({
        symbol: candidate.symbol,
        pass: false,
        candidate: null,
        direction: review.direction ?? "none",
        reviewScore: review.score,
        summary: review.summary,
        rejectionReason: failReason,
      });
      continue;
    }

    evaluations.push({
      symbol: candidate.symbol,
      pass: true,
      candidate: {
        ...candidate,
        chartDirection: review.direction,
        chartMovePct: review.movePct,
        volumeRatio: review.volumeRatio,
        chartReviewSummary: review.summary,
        chartReviewScore: review.score,
        chartDiagnostics: review.diagnostics,
      },
      direction: review.direction,
      reviewScore: review.score,
      summary: review.summary,
      rejectionReason: null,
    });
  }

  return evaluations;
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
  if (failedChecks.includes("impulse-consolidation")) {
    reasons.push("impulse/hold quality");
  }
  if (failedChecks.includes("fake-hold-distribution")) {
    reasons.push("distribution risk");
  }
  if (failedChecks.includes("failed-breakout-trap")) {
    reasons.push("bull/bear trap risk");
  }
  if (failedChecks.includes("higher-timeframe-2r-viability")) {
    reasons.push("2R room tight");
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

function summarizeCheckOutcomes(checks: Stage3CheckDiagnostic[]): string {
  return checks.map((check) => `${check.check}:${check.pass ? "pass" : "fail"}`).join(", ");
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

  const consolidationBars = bars1D.slice(-6, -1);
  const impulseBars = bars1D.slice(-12, -6);

  const averageRangeFor = (bars: Record<string, unknown>[]): number | null => {
    let sum = 0;
    let count = 0;
    for (const bar of bars) {
      const barHigh = readNumber(bar, ["High"]);
      const barLow = readNumber(bar, ["Low"]);
      if (barHigh !== null && barLow !== null && barHigh > barLow) {
        sum += barHigh - barLow;
        count += 1;
      }
    }

    return count > 0 ? sum / count : null;
  };

  const impulseAverageRange = averageRangeFor(impulseBars);
  const consolidationAverageRange = averageRangeFor(consolidationBars);
  const impulseStartClose = readNumber(impulseBars[0] ?? null, ["Close"]);
  const impulseEndClose = readNumber(impulseBars[impulseBars.length - 1] ?? null, ["Close"]);
  const impulseMovePct =
    impulseStartClose !== null && impulseEndClose !== null && impulseStartClose > 0
      ? ((impulseEndClose - impulseStartClose) / impulseStartClose) * 100
      : null;
  const impulseMoveDirectionalPass =
    impulseMovePct === null
      ? false
      : direction === "bullish"
        ? impulseMovePct >= 1.2
        : impulseMovePct <= -1.2;
  const consolidationTightPass =
    impulseAverageRange !== null && consolidationAverageRange !== null && impulseAverageRange > 0
      ? consolidationAverageRange <= impulseAverageRange * 0.9
      : false;
  const impulseConsolidationPass = impulseMoveDirectionalPass && consolidationTightPass;

  const consolidationHighs = consolidationBars
    .map((bar) => readNumber(bar, ["High"]))
    .filter((value): value is number => value !== null);
  const consolidationLows = consolidationBars
    .map((bar) => readNumber(bar, ["Low"]))
    .filter((value): value is number => value !== null);
  const consolidationRangeHigh = consolidationHighs.length > 0 ? Math.max(...consolidationHighs) : null;
  const consolidationRangeLow = consolidationLows.length > 0 ? Math.min(...consolidationLows) : null;

  const lowerHighCount = (() => {
    if (consolidationHighs.length < 2) {
      return 0;
    }

    let count = 0;
    for (let index = 1; index < consolidationHighs.length; index += 1) {
      const currentHigh = consolidationHighs[index];
      const previousHigh = consolidationHighs[index - 1];
      if (currentHigh !== undefined && previousHigh !== undefined && currentHigh < previousHigh) {
        count += 1;
      }
    }
    return count;
  })();

  const consolidationCloses = consolidationBars
    .map((bar) => readNumber(bar, ["Close"]))
    .filter((value): value is number => value !== null);
  const lowerZoneCloseCount = (() => {
    if (consolidationRangeHigh === null || consolidationRangeLow === null || consolidationRangeHigh <= consolidationRangeLow) {
      return 0;
    }

    const cutoff = consolidationRangeLow + (consolidationRangeHigh - consolidationRangeLow) * 0.35;
    return consolidationCloses.filter((value) => value <= cutoff).length;
  })();

  const fakeHoldDistributionPass =
    (direction === "bullish" && lowerHighCount <= 2 && lowerZoneCloseCount <= 2) ||
    (direction === "bearish" && lowerHighCount <= 2);

  const keyLevel = direction === "bullish"
    ? readNumber(bars1D[bars1D.length - 2] ?? null, ["High"])
    : readNumber(bars1D[bars1D.length - 2] ?? null, ["Low"]);
  const failedBreakoutBullTrapPass =
    direction === "bullish"
      ? keyLevel !== null && !(high > keyLevel && close < keyLevel)
      : keyLevel !== null && !(low < keyLevel && close > keyLevel);

  const pullbackBars = consolidationBars.filter((bar) => {
    const barOpen = readNumber(bar, ["Open"]);
    const barClose = readNumber(bar, ["Close"]);
    if (barOpen === null || barClose === null) {
      return false;
    }

    return direction === "bullish" ? barClose < barOpen : barClose > barOpen;
  });

  const averageBodyFor = (bars: Record<string, unknown>[]): number | null => {
    let sum = 0;
    let count = 0;
    for (const bar of bars) {
      const barOpen = readNumber(bar, ["Open"]);
      const barClose = readNumber(bar, ["Close"]);
      if (barOpen !== null && barClose !== null) {
        sum += Math.abs(barClose - barOpen);
        count += 1;
      }
    }

    return count > 0 ? sum / count : null;
  };

  const pullbackAverageBody = averageBodyFor(pullbackBars);
  const consolidationAverageBody = averageBodyFor(consolidationBars);
  const pullbackBodyControlPass =
    pullbackAverageBody === null || consolidationAverageBody === null || consolidationAverageBody <= 0
      ? true
      : pullbackAverageBody <= consolidationAverageBody * 1.1;

  const pullbackVolumes = pullbackBars
    .map((bar) => readNumber(bar, ["TotalVolume", "Volume", "Vol", "TotalVolumeTraded"]))
    .filter((value): value is number => value !== null);
  const averagePullbackVolume = pullbackVolumes.length > 0
    ? pullbackVolumes.reduce((sum, value) => sum + value, 0) / pullbackVolumes.length
    : null;
  const nonPullbackBars = consolidationBars.filter((bar) => !pullbackBars.includes(bar));
  const averageNonPullbackVolume = (() => {
    const values = nonPullbackBars
      .map((bar) => readNumber(bar, ["TotalVolume", "Volume", "Vol", "TotalVolumeTraded"]))
      .filter((value): value is number => value !== null);
    if (values.length === 0) {
      return null;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
  })();
  const pullbackVolumeTrendUp =
    pullbackVolumes.length >= 2 ? pullbackVolumes[pullbackVolumes.length - 1]! > pullbackVolumes[0]! : false;
  const pullbackSellingVolumePass =
    averagePullbackVolume === null || averageNonPullbackVolume === null
      ? true
      : !(averagePullbackVolume > averageNonPullbackVolume * 1.05 && pullbackVolumeTrendUp);

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
  const higherTimeframe2RPass = roomPct === null || roomPct >= 2;
  const higherTimeframeContextPresent = direction === "bullish" ? max3M !== null && max1Y !== null : min3M !== null && min1Y !== null;

  const triggerZoneFlipCount = (() => {
    const triggerCloses = bars1D.slice(-6).map((bar) => readNumber(bar, ["Close"]));
    let flips = 0;
    for (let index = 2; index < triggerCloses.length; index += 1) {
      const a = triggerCloses[index - 2];
      const b = triggerCloses[index - 1];
      const c = triggerCloses[index];
      if (a === null || b === null || c === null || a === undefined || b === undefined || c === undefined) {
        continue;
      }

      const prevDelta = b - a;
      const currentDelta = c - b;
      if (prevDelta === 0 || currentDelta === 0) {
        continue;
      }
      if (Math.sign(prevDelta) !== Math.sign(currentDelta)) {
        flips += 1;
      }
    }
    return flips;
  })();
  const messyTriggerZonePass = triggerZoneFlipCount <= 2 && choppyPass;

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
    {
      check: "impulse-consolidation",
      pass: impulseConsolidationPass,
      reason: `impulseMovePct=${impulseMovePct === null ? "n/a" : `${impulseMovePct.toFixed(2)}%`}, impulseAvgRange=${impulseAverageRange?.toFixed(2) ?? "n/a"}, consolidationAvgRange=${consolidationAverageRange?.toFixed(2) ?? "n/a"}`,
    },
    {
      check: "fake-hold-distribution",
      pass: fakeHoldDistributionPass,
      reason: `lowerHighCount=${lowerHighCount}, lowerZoneCloseCount=${lowerZoneCloseCount}`,
    },
    {
      check: "failed-breakout-trap",
      pass: failedBreakoutBullTrapPass,
      reason: direction === "bullish" ? `high=${high.toFixed(2)}, close=${close.toFixed(2)}, keyLevel=${keyLevel?.toFixed(2) ?? "n/a"}` : `low=${low.toFixed(2)}, close=${close.toFixed(2)}, keyLevel=${keyLevel?.toFixed(2) ?? "n/a"}`,
    },
    {
      check: "pullback-body-control",
      pass: pullbackBodyControlPass,
      reason: `pullbackAvgBody=${pullbackAverageBody?.toFixed(2) ?? "n/a"}, consolidationAvgBody=${consolidationAverageBody?.toFixed(2) ?? "n/a"}`,
    },
    {
      check: "pullback-volume-control",
      pass: pullbackSellingVolumePass,
      reason: `pullbackAvgVol=${averagePullbackVolume?.toFixed(0) ?? "n/a"}, nonPullbackAvgVol=${averageNonPullbackVolume?.toFixed(0) ?? "n/a"}, trendUp=${pullbackVolumeTrendUp ? "yes" : "no"}`,
    },
    {
      check: "trigger-zone-clean",
      pass: messyTriggerZonePass,
      reason: `triggerZoneFlipCount=${triggerZoneFlipCount}`,
    },
    { check: "continuation", pass: continuationPass, reason: direction === "bullish" ? `close=${close.toFixed(2)} vs prevHigh=${prevHigh?.toFixed(2) ?? "n/a"}` : `close=${close.toFixed(2)} vs prevLow=${prevLow?.toFixed(2) ?? "n/a"}` },
    {
      check: "higher-timeframe-context",
      pass: higherTimeframeContextPresent,
      reason: higherTimeframeContextPresent ? "3M/1Y highs/lows available" : "missing higher-timeframe context (3M/1Y high/low data)",
    },
    { check: "higher-timeframe-room", pass: higherTimeframeRoomPass, reason: `roomPct=${roomPct === null ? "n/a" : roomPct.toFixed(2)}%` },
    { check: "higher-timeframe-2r-viability", pass: higherTimeframe2RPass, reason: `roomPct=${roomPct === null ? "n/a" : roomPct.toFixed(2)}%, requires >=2.00%` },
  ];

  const checks = [
    expansionPass,
    bodyQualityPass,
    volumePass,
    choppyPass,
    continuationPass,
    higherTimeframeRoomPass,
    impulseConsolidationPass,
    fakeHoldDistributionPass,
    failedBreakoutBullTrapPass,
    pullbackBodyControlPass,
    pullbackSellingVolumePass,
    messyTriggerZonePass,
    higherTimeframe2RPass,
  ];
  const passedChecks = checks.filter(Boolean).length;
  const pass = passedChecks >= 8 && continuationPass && higherTimeframe2RPass && failedBreakoutBullTrapPass;

  const detailParts = [
    `expansion ${expansionPass ? "ok" : "weak"}`,
    `body/wick ${bodyQualityPass ? "clean" : "messy"}`,
    `volume ${volumePass ? "supports" : "light"}`,
    `chop ${choppyPass ? "contained" : "high"}`,
    `impulse/hold ${impulseConsolidationPass ? "clean" : "weak"}`,
    `distribution ${fakeHoldDistributionPass ? "limited" : "elevated"}`,
    `trap-risk ${failedBreakoutBullTrapPass ? "low" : "present"}`,
    `pullback-body ${pullbackBodyControlPass ? "controlled" : "heavy"}`,
    `pullback-volume ${pullbackSellingVolumePass ? "controlled" : "expanding sell"}`,
    `trigger-zone ${messyTriggerZonePass ? "clean" : "messy"}`,
    `continuation ${continuationPass ? "yes" : "rejection risk"}`,
    `HTF room ${higherTimeframeRoomPass ? "adequate" : "limited"}`,
    `HTF 2R ${higherTimeframe2RPass ? "viable" : "tight"}`,
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

function parseYahooEarningsDate(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const quoteSummary = (payload as Record<string, unknown>)["quoteSummary"];
  if (!quoteSummary || typeof quoteSummary !== "object") {
    return null;
  }

  const result = (quoteSummary as Record<string, unknown>)["result"];
  if (!Array.isArray(result) || result.length === 0) {
    return null;
  }

  const firstResult = result[0];
  if (!firstResult || typeof firstResult !== "object") {
    return null;
  }

  const calendarEvents = (firstResult as Record<string, unknown>)["calendarEvents"];
  if (!calendarEvents || typeof calendarEvents !== "object") {
    return null;
  }

  const earnings = (calendarEvents as Record<string, unknown>)["earnings"];
  if (!earnings || typeof earnings !== "object") {
    return null;
  }

  const earningsDate = (earnings as Record<string, unknown>)["earningsDate"];
  if (!Array.isArray(earningsDate) || earningsDate.length === 0) {
    return null;
  }

  const firstDate = earningsDate[0];
  if (!firstDate || typeof firstDate !== "object") {
    return null;
  }

  const raw = (firstDate as Record<string, unknown>)["raw"];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw * 1000).toISOString().slice(0, 10);
  }

  const formatted = (firstDate as Record<string, unknown>)["fmt"];
  if (typeof formatted === "string" && formatted.trim().length > 0) {
    const parsed = new Date(formatted);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }

  return null;
}

async function fetchEarningsDate(symbol: string): Promise<string | null> {
  const requestUrl = `${YAHOO_FINANCE_BASE_URL}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents`;
  const response = await fetch(requestUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  return parseYahooEarningsDate(payload);
}

async function runEarningsCheck(symbol: string, windowMinDte: number, windowMaxDte: number): Promise<EarningsCheckResult> {
  const normalizedWindowMin = Math.max(0, Math.min(windowMinDte, windowMaxDte));
  const normalizedWindowMax = Math.max(normalizedWindowMin, windowMaxDte);

  let earningsDate: string | null = null;
  try {
    earningsDate = await fetchEarningsDate(symbol);
  } catch {
    earningsDate = null;
  }

  if (!earningsDate) {
    return {
      symbol,
      earningsDate: null,
      windowMinDte: normalizedWindowMin,
      windowMaxDte: normalizedWindowMax,
      pass: true,
      reason: "No earnings date was found from the scoped lookup.",
    };
  }

  const earningsDte = getDte(new Date(earningsDate));
  const insideWindow = earningsDte >= normalizedWindowMin && earningsDte <= normalizedWindowMax;

  if (insideWindow) {
    return {
      symbol,
      earningsDate,
      windowMinDte: normalizedWindowMin,
      windowMaxDte: normalizedWindowMax,
      pass: false,
      reason: `Earnings is inside the DTE window (earnings DTE ${earningsDte}, window ${normalizedWindowMin}-${normalizedWindowMax}).`,
    };
  }

  return {
    symbol,
    earningsDate,
    windowMinDte: normalizedWindowMin,
    windowMaxDte: normalizedWindowMax,
    pass: true,
    reason: `Earnings is outside the DTE window (earnings DTE ${earningsDte}, window ${normalizedWindowMin}-${normalizedWindowMax}).`,
  };
}

function logEarningsCheckDebug(result: EarningsCheckResult): void {
  if (process.env.SCANNER_DEBUG !== "1") {
    return;
  }

  console.log(
    `[scanner:debug] earnings-check ${result.symbol}: earningsDate=${result.earningsDate ?? "n/a"} | dteWindow=${result.windowMinDte}-${result.windowMaxDte} | pass=${result.pass ? "yes" : "no"}`,
  );
}

async function resolveTargetDteForSymbol(
  get: (path: string) => Promise<Response>,
  symbol: string,
): Promise<number | null> {
  const expirationsResponse = await get(`/marketdata/options/expirations/${encodeURIComponent(symbol)}`);
  if (!expirationsResponse.ok) {
    return null;
  }

  const expirationsPayload = await expirationsResponse.json();
  const expirations = readExpirations(expirationsPayload);
  if (expirations.length === 0) {
    return null;
  }

  const inRange = expirations.filter((item) => item.dte >= 14 && item.dte <= 21);
  const targetExpiration = (inRange.length > 0 ? inRange : expirations).sort(
    (a, b) => Math.abs(a.dte - 17) - Math.abs(b.dte - 17),
  )[0];

  return targetExpiration?.dte ?? null;
}

export function readExpirations(payload: unknown): OptionExpirationCandidate[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  const rawExpirations = objectPayload["Expirations"];
  if (!Array.isArray(rawExpirations)) {
    return [];
  }

  const results: OptionExpirationCandidate[] = [];

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

export function pickTargetExpiration(
  expirations: OptionExpirationCandidate[],
  dteMin: number,
  dteMax: number,
  dteCenter: number,
): OptionExpirationCandidate | null {
  if (expirations.length === 0) {
    return null;
  }

  const inRange = expirations.filter((item) => item.dte >= dteMin && item.dte <= dteMax);
  return (inRange.length > 0 ? inRange : expirations).sort((a, b) => Math.abs(a.dte - dteCenter) - Math.abs(b.dte - dteCenter))[0] ?? null;
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

export function readStrikes(payload: unknown): {
  strikes: OptionStrikeCandidate[];
  rawStrikeCount: number;
  normalizedStrikeCount: number;
} {
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

  const results: OptionStrikeCandidate[] = [];
  for (const contract of contracts) {
    const strike = readNumber(contract, ["Strike", "StrikePrice", "Price"]);
    if (strike === null) {
      continue;
    }

    const callSymbol = readText(contract, ["CallSymbol", "Call", "OptionSymbol", "Symbol"]);
    const putSymbol = readText(contract, ["PutSymbol", "Put"]);
    results.push({ strike, callSymbol, putSymbol });
  }

  const deduped = new Map<number, OptionStrikeCandidate>();
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

export function buildOptionSymbol(symbol: string, expirationDate: string, type: "C" | "P", strike: number): string {
  const [yearText, monthText, dayText] = expirationDate.split("-");
  const yearShort = yearText?.slice(-2) ?? "00";
  const month = monthText ?? "01";
  const day = dayText ?? "01";
  const strikeText = Number.isInteger(strike)
    ? strike.toString()
    : strike.toFixed(3).replace(/\.?0+$/, "");
  return `${symbol} ${yearShort}${month}${day}${type}${strikeText}`;
}


export function buildDirectOptionSymbols(
  symbol: string,
  expirationDate: string,
  strike: OptionStrikeCandidate,
): string[] {
  return [
    strike.callSymbol,
    strike.putSymbol,
    buildOptionSymbol(symbol, expirationDate, "C", strike.strike),
    buildOptionSymbol(symbol, expirationDate, "P", strike.strike),
  ].filter((item, index, list): item is string => {
    if (typeof item !== "string" || item.trim().length === 0) {
      return false;
    }

    return list.indexOf(item) === index;
  });
}

export async function fetchFirstUsableDirectOptionQuote(
  get: (path: string) => Promise<Response>,
  symbolsToTry: string[],
): Promise<{ quote: DirectOptionQuoteData | null; attempts: DirectOptionQuoteAttempt[] }> {
  const attempts: DirectOptionQuoteAttempt[] = [];
  let capturedFirstHttp200Payload = false;

  for (const optionSymbol of symbolsToTry) {
    const requestTarget = `/marketdata/quotes/${encodeURIComponent(optionSymbol)}`;
    const optionQuoteResponse = await get(requestTarget);
    if (!optionQuoteResponse.ok) {
      attempts.push({
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
      attempts.push({
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

    const parsedBid = bid as number;
    const parsedAsk = ask as number;
    const parsedOpenInterest = openInterest as number;
    const quote: DirectOptionQuoteData = {
      optionSymbol,
      openInterest: parsedOpenInterest,
      spread: parsedAsk - parsedBid,
      mid: (parsedAsk + parsedBid) / 2,
      bid: parsedBid,
      ask: parsedAsk,
    };
    attempts.push({
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
    return { quote, attempts };
  }

  return { quote: null, attempts };
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

    const symbolsToTry = buildDirectOptionSymbols(candidate.symbol, targetExpiration.date, selectedStrike);

    const { quote: quoteData, attempts } = await fetchFirstUsableDirectOptionQuote(get, symbolsToTry);
    diagnostic.optionQuoteAttempts.push(...attempts);

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
  const stage1BySymbol = new Map(stage1Passed.map((candidate) => [candidate.symbol, candidate]));

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
  const stage2BySymbol = new Map(stage2Passed.map((candidate) => [candidate.symbol, candidate]));
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
  const stage3Evaluations = await evaluateStage3Candidates(get, stage2Passed);
  const stage3Passed = stage3Evaluations.flatMap((item) => (item.candidate ? [item.candidate] : []));
  const stage3BySymbol = new Map(stage3Passed.map((candidate) => [candidate.symbol, candidate]));

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

  // Stage 4: simple final score and finalist list
  const { ranked, debug: finalRankingDebug } = buildFinalRanking(stage3Passed);
  logStage3PassThroughDebugSection(stage3Evaluations, finalRankingDebug, ranked[0]?.score ?? null);
  logFinalRankingDebugSection(finalRankingDebug);

  const finalists = ranked.slice(0, FINALIST_REVIEW_LIMIT);
  if (finalists.length === 0) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: "No final candidate was available after scoring.",
    };
  }

  const finalistReviewResults: FinalistReviewResult[] = [];
  for (const finalist of finalists) {
    const finalistStage2Inputs = stage2BySymbol.get(finalist.symbol);
    const finalistDte = finalistStage2Inputs?.targetDte;
    if (finalistDte !== undefined) {
      const earningsCheck = await runEarningsCheck(finalist.symbol, 0, finalistDte);
      logEarningsCheckDebug(earningsCheck);
      if (!earningsCheck.pass) {
        finalistReviewResults.push({
          symbol: finalist.symbol,
          rankingScore: finalist.score,
          stage1Inputs: (() => {
            const item = stage1BySymbol.get(finalist.symbol);
            return item ? { lastPrice: item.lastPrice, averageVolume: item.averageVolume } : null;
          })(),
          stage2Inputs: finalistStage2Inputs
            ? {
              targetExpiration: finalistStage2Inputs.targetExpiration,
              targetDte: finalistStage2Inputs.targetDte,
              optionOpenInterest: finalistStage2Inputs.optionOpenInterest,
              optionSpread: finalistStage2Inputs.optionSpread,
              optionMid: finalistStage2Inputs.optionMid,
            }
            : null,
          stage3Inputs: (() => {
            const item = stage3BySymbol.get(finalist.symbol);
            return item
              ? {
                direction: item.chartDirection,
                movePct: item.chartMovePct,
                volumeRatio: item.volumeRatio,
                chartReviewScore: item.chartReviewScore,
                chartReviewSummary: item.chartReviewSummary,
                structureChecks: summarizeCheckOutcomes(item.chartDiagnostics.checks),
              }
              : null;
          })(),
          conclusion: "rejected",
          reason: `Rejected by earnings-inside-DTE exclusion. ${earningsCheck.reason}`,
        });
        continue;
      }
    }

    const reviewResult = await runSingleSymbolTradeStationAnalysis(finalist.symbol);
    finalistReviewResults.push({
      symbol: finalist.symbol,
      rankingScore: finalist.score,
      stage1Inputs: (() => {
        const item = stage1BySymbol.get(finalist.symbol);
        return item ? { lastPrice: item.lastPrice, averageVolume: item.averageVolume } : null;
      })(),
      stage2Inputs: (() => {
        const item = stage2BySymbol.get(finalist.symbol);
        return item
          ? {
              targetExpiration: item.targetExpiration,
              targetDte: item.targetDte,
              optionOpenInterest: item.optionOpenInterest,
              optionSpread: item.optionSpread,
              optionMid: item.optionMid,
            }
          : null;
      })(),
      stage3Inputs: (() => {
        const item = stage3BySymbol.get(finalist.symbol);
        return item
          ? {
              direction: item.chartDirection,
              movePct: item.chartMovePct,
              volumeRatio: item.volumeRatio,
              chartReviewScore: item.chartReviewScore,
              chartReviewSummary: item.chartReviewSummary,
              structureChecks: summarizeCheckOutcomes(item.chartDiagnostics.checks),
            }
          : null;
      })(),
      conclusion: reviewResult.conclusion,
      reason: reviewResult.reason,
    });

    if (reviewResult.conclusion === "confirmed" && reviewResult.ticker && reviewResult.direction && reviewResult.confidence) {
      logGeneralScanDebug("Final selected", [reviewResult.ticker]);
      logFinalistReviewDebugSection(finalistReviewResults, reviewResult.ticker);
      return {
        ticker: reviewResult.ticker,
        direction: reviewResult.direction,
        confidence: reviewResult.confidence,
        conclusion: "confirmed",
        reason: `Finalist confirmation passed after Stage 1/2/3 scoring (reviewed: ${finalists.map((item) => item.symbol).join(", ")}; selected: ${reviewResult.ticker}; rank score ${finalist.score.toFixed(2)}). ${getSelectionWhyWonReason(finalistReviewResults, reviewResult.ticker)} ${reviewResult.reason}`,
      };
    }
  }

  logFinalistReviewDebugSection(finalistReviewResults, null);
  return {
    ticker: null,
    direction: null,
    confidence: null,
    conclusion: "no_trade_today",
    reason: `Finalists were reviewed but none were confirmed (${finalists.map((item) => item.symbol).join(", ")}).`,
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

  const stage3Evaluations = await evaluateStage3Candidates(get, stage2Passed);
  const stage3Passed = stage3Evaluations.flatMap((item) => (item.candidate ? [item.candidate] : []));
  const stage3NearMissCandidates: Stage3NearMiss[] = [];
  for (const evaluation of stage3Evaluations) {
    if (evaluation.pass) {
      continue;
    }

    if (evaluation.rejectionReason) {
      incrementSummary(stage3RejectionSummary, evaluation.rejectionReason);
    }

    stage3NearMissCandidates.push({
      symbol: evaluation.symbol,
      direction: evaluation.direction,
      score: evaluation.reviewScore,
      failReasons: [evaluation.rejectionReason ?? "other"],
    });
  }

  const { ranked, debug: finalRankingDebug } = buildFinalRanking(stage3Passed);

  const nearMisses = stage3NearMissCandidates
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, 3);

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
    stage3PassedDetails: stage3Passed.map((candidate) => ({
      symbol: candidate.symbol,
      direction: candidate.chartDirection,
      score: scoreStage3Candidate(candidate),
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

export async function runSingleSymbolTradeStationAnalysis(symbol: string): Promise<ScanResult> {
  const get = await createTradeStationGetFetcher();
  const targetDte = await resolveTargetDteForSymbol(get, symbol);
  if (targetDte !== null) {
    const earningsCheck = await runEarningsCheck(symbol, 0, targetDte);
    logEarningsCheckDebug(earningsCheck);
    if (!earningsCheck.pass) {
      return {
        ticker: symbol,
        direction: null,
        confidence: null,
        conclusion: "rejected",
        reason: `Single-symbol review rejected due to earnings risk inside the target DTE window. ${earningsCheck.reason}`,
      };
    }
  }

  const { barsByView: bars, timeframeDiagnostics } = await loadMultiTimeframeBars(get, symbol);
  if (bars) {
    const review = runStage3ChartReview(bars, timeframeDiagnostics);
    const reviewNarrative = buildSingleSymbolReviewNarrative(review);

    if (review.pass && review.direction) {
      const confidence: ScanConfidence = review.score >= 5 ? "85-92" : review.score >= 4 ? "75-84" : "65-74";
      return {
        ticker: symbol,
        direction: review.direction,
        confidence,
        conclusion: "confirmed",
        reason: reviewNarrative,
      };
    }

    return {
      ticker: symbol,
      direction: review.direction,
      confidence: null,
      conclusion: "rejected",
      reason: reviewNarrative,
    };
  }

  return {
    ticker: symbol,
    direction: null,
    confidence: null,
    conclusion: "no_trade_today",
    reason: "Could not review the full 1D/1W/1M/3M/1Y chart context from TradeStation data, so no_trade_today.",
  };
}

function buildSingleSymbolReviewNarrative(review: ChartReviewResult): string {
  const checkByName = new Map(review.diagnostics.checks.map((item) => [item.check, item]));
  const bodyToRange = review.diagnostics.bodyToRange;
  const wickiness = review.diagnostics.wickiness;
  const volumeRatio = review.volumeRatio;
  const roomPct = review.diagnostics.roomPct;

  const supportive: string[] = [];
  const problematic: string[] = [];

  supportive.push(`1D/1W alignment ${review.diagnostics.alignmentPass ? "supports the setup" : "is not clean"} (${review.diagnostics.alignmentReason})`);

  if (checkByName.get("body-wick")?.pass) {
    supportive.push(`candle body/wick quality looks constructive (body/range ${bodyToRange?.toFixed(2) ?? "n/a"}, wickiness ${wickiness?.toFixed(2) ?? "n/a"})`);
  } else {
    problematic.push(`candle body/wick quality is weaker than preferred (body/range ${bodyToRange?.toFixed(2) ?? "n/a"}, wickiness ${wickiness?.toFixed(2) ?? "n/a"})`);
  }

  if (checkByName.get("volume")?.pass) {
    supportive.push(`volume confirms participation (${volumeRatio === null ? "ratio n/a" : `ratio ${volumeRatio.toFixed(2)}x`})`);
  } else {
    problematic.push(`volume confirmation is limited (${volumeRatio === null ? "ratio unavailable" : `ratio ${volumeRatio.toFixed(2)}x`})`);
  }

  if (checkByName.get("continuation")?.pass) {
    supportive.push("price action still looks more like continuation than rejection");
  } else {
    problematic.push("price action shows rejection risk versus clean continuation");
  }

  if (checkByName.get("impulse-consolidation")?.pass) {
    supportive.push("impulse plus consolidation structure is present (expansion then tighter hold)");
  } else {
    problematic.push("impulse plus consolidation structure is not clean enough");
  }

  if (checkByName.get("fake-hold-distribution")?.pass && checkByName.get("failed-breakout-trap")?.pass) {
    supportive.push("fake-hold/distribution and trap behavior look controlled");
  } else {
    problematic.push("fake-hold/distribution or trap behavior is elevated");
  }

  if (checkByName.get("higher-timeframe-room")?.pass) {
    supportive.push(`higher-timeframe room/resistance appears workable (${roomPct === null ? "room n/a" : `${roomPct.toFixed(2)}% room`})`);
  } else {
    problematic.push(`higher-timeframe room/resistance looks tight (${roomPct === null ? "room n/a" : `${roomPct.toFixed(2)}% room`})`);
  }

  const structureInPrinciple =
    review.diagnostics.alignmentPass &&
    !!checkByName.get("body-wick")?.pass &&
    !!checkByName.get("continuation")?.pass &&
    !!checkByName.get("impulse-consolidation")?.pass &&
    !!checkByName.get("failed-breakout-trap")?.pass &&
    !!checkByName.get("higher-timeframe-room")?.pass &&
    !!checkByName.get("higher-timeframe-2r-viability")?.pass;
  if (structureInPrinciple) {
    supportive.push("the chart supports a clean 2:1-style structure in principle");
  } else {
    problematic.push("a clean 2:1-style structure is not clearly supported yet");
  }

  const timeframeStatus = (["1D", "1W", "1M", "3M", "1Y"] as MultiTimeframeView[])
    .map((view) => `${view}:${review.diagnostics.timeframeDiagnostics[view]?.barCount ?? 0}`)
    .join(", ");

  return `Single-symbol chart review (${review.direction ?? "neutral"}) across 1D/1W/1M/3M/1Y [bars ${timeframeStatus}]. Supportive: ${
    supportive.length > 0 ? supportive.join("; ") : "none"
  }. Problematic: ${problematic.length > 0 ? problematic.join("; ") : "none"}.`;
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
