import { ALL_SCAN_UNIVERSE_SET, CORE_SCAN_UNIVERSE, SCAN_UNIVERSE_TIERS, type ScanUniverseTier, type ScanUniverseTierKey } from "../config/scanUniverseTiers.js";
import { getFakeConfidence, type ScanConfidence, type ScanDirection } from "../scanner/scoring.js";
import { createTradeStationGetFetcher } from "../tradestation/client.js";
import { evaluateChartAnchoredTradability } from "./chartAnchoredTradability.js";
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
  telemetry?: StarterUniverseTelemetry | null;
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

type Stage2ContractEvaluation = {
  strike: OptionStrikeCandidate;
  quote: DirectOptionQuoteData | null;
  attempts: DirectOptionQuoteAttempt[];
  reason: string;
  spreadPercent: number | null;
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
  impact: "blocker" | "downgrader" | "mild_caution";
};

type Stage3IssueSeverity = "hard_veto" | "score_penalty" | "info";

type Stage3IssueBreakdown = {
  hardVetoes: string[];
  softIssues: string[];
  info: string[];
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
  roomToTargetDiagnostics: {
    referencePrice: number;
    direction: ScanDirection;
    levelDetection: string;
    levelStrength: string;
    levelUsed: number | null;
    roomPct: number | null;
    targetAssumption: string;
    decisionMode: "hard_fail" | "score_penalty";
    roomTier: "obvious_no_room" | "borderline_tight" | "workable" | "unknown";
    sufficientRoom: boolean;
    insufficientRoomReason: string;
  };
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
  hardFailReasons: string[];
  softIssueReasons: string[];
  infoReasons: string[];
  failReasons: string[];
  roomToTargetDiagnostics: Stage3Diagnostics["roomToTargetDiagnostics"] | null;
};

type FinalRankingEntry = {
  symbol: string;
  direction: ScanDirection;
  score: number | null;
  enteredFinalRanking: boolean;
  topRankedCandidate: boolean;
  confirmedFinalSelection: boolean;
  selected: boolean;
  selectedFieldMeaning: string;
  reason: string;
  scoreInputs: {
    movePct: number;
    optionOpenInterest: number;
    optionSpread: number;
    optionMid: number;
    volumeRatio: number | null;
    chartReviewScore: number;
    continuationPass: boolean;
    continuationPenalty: number;
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
  issueBreakdown: Stage3IssueBreakdown;
  roomToTargetDiagnostics: Stage3Diagnostics["roomToTargetDiagnostics"] | null;
};

type FinalistReviewResult = {
  symbol: string;
  direction: ScanDirection | null;
  confidence: ScanConfidence | null;
  reviewStatus: "reviewed";
  confirmationStatus: "confirmed" | "rejected";
  confirmationFailureReasons: string[];
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
    roomToTargetDecision: string;
  } | null;
  conclusion: ScanResult["conclusion"];
  reason: string;
};

type ConfirmationDebug = {
  reviewStatus: "reviewed";
  confirmationStatus: "confirmed" | "rejected";
  confirmationFailureReasons: string[];
  continuationPass: boolean;
  higherTimeframeRoomPass: boolean;
  higherTimeframe2RPass: boolean;
  supportsTradable2RStructure: boolean;
  rejectedBecauseConfidenceBelow75: boolean;
  weightedSoftIssueScore: number;
  topBlockingReasons: string[];
};

type SingleSymbolReviewResult = ScanResult & {
  confirmationDebug?: ConfirmationDebug;
};

type ReviewedFinalistOutcome = {
  symbol: string;
  tier: ScanUniverseTierKey;
  tierLabel: string;
  direction: ScanDirection | null;
  confidence: ScanConfidence | null;
  confirmationFailureReasons: string[];
  rankingScore: number;
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

type StarterUniverseStageCounts = {
  stage1Entered: number;
  stage1Passed: number;
  stage2Passed: number;
  stage3Passed: number;
  continuationEligibleFinalists: number;
  confirmationEligibleFinalists: number;
  finalistsReviewed: number;
  finalRanking: number;
};

type StarterUniverseStageSymbols = {
  stage1Entered: string[];
  stage1Passed: string[];
  stage2Passed: string[];
  stage3Passed: string[];
  continuationEligibleFinalists: string[];
  confirmationEligibleFinalists: string[];
  finalistsReviewed: string[];
  finalRanking: string[];
};

type TierSummary = {
  tier: ScanUniverseTierKey;
  label: string;
  description: string;
  counts: StarterUniverseStageCounts;
  symbols: StarterUniverseStageSymbols;
  finalistsReviewed: string[];
  concludedWith: ScanResult["conclusion"];
  winner: string | null;
  noTradeReason: string | null;
};

export type StarterUniverseTelemetry = {
  stageCounts: StarterUniverseStageCounts;
  stageSymbols: StarterUniverseStageSymbols;
  finalistsReviewedDebug: {
    symbol: string;
    eligibleForReviewReason: string;
    sourceList: "stage3Passed" | "stage2PassedOnly" | "missingUpstream";
    inStage2Passed: boolean;
    inStage3Passed: boolean;
    upstreamConsistencyOk: boolean;
    upstreamConsistencyWarning: string | null;
  }[];
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
  consistencyChecks: string[];
  finalSelectedSymbol: string | null;
  topRankedSymbol: string | null;
  scannedTiers: ScanUniverseTierKey[];
  winningTier: ScanUniverseTierKey | null;
  tierSummaries: TierSummary[];
  tierStageCounts: Partial<Record<ScanUniverseTierKey, StarterUniverseStageCounts>>;
  tierFinalistsReviewed: Partial<Record<ScanUniverseTierKey, string[]>>;
  cumulativeStageCounts: StarterUniverseStageCounts;
  finalNoTradeExplanation: string | null;
  reviewedFinalistOutcomes: ReviewedFinalistOutcome[];
  bestReviewedFinalistsAcrossTiers: string[];
  bestRejectedCandidates: {
    symbol: string;
    tier: ScanUniverseTierKey;
    tierLabel: string;
    rejectionReasons: string[];
  }[];
  crossTierFinalistSummary: string | null;
};

type FinalistReviewSource = {
  continuationEligibleFinalists: (ChartCandidate & { score: number })[];
  confirmationEligibleFinalists: (ChartCandidate & { score: number })[];
  finalists: (ChartCandidate & { score: number })[];
  debug: StarterUniverseTelemetry["finalistsReviewedDebug"];
  warnings: string[];
};

function buildStarterUniverseTelemetry(params: {
  stage1Entered: string[];
  stage1Passed: Stage1Candidate[];
  stage2Passed: OptionsCandidate[];
  stage3Evaluations: Stage3Evaluation[];
  ranked: (ChartCandidate & { score: number })[];
  finalRankingDebug: FinalRankingEntry[];
  finalistReviewSource: FinalistReviewSource;
  finalistReviewResults: FinalistReviewResult[];
  rejectionSummaries: StarterUniverseTelemetry["rejectionSummaries"];
  selectedSymbol: string | null;
  scannedTiers?: ScanUniverseTierKey[];
  winningTier?: ScanUniverseTierKey | null;
  tierSummaries?: TierSummary[];
  finalNoTradeExplanation?: string | null;
}): StarterUniverseTelemetry {
  const {
    stage1Entered,
    stage1Passed,
    stage2Passed,
    stage3Evaluations,
    ranked,
    finalRankingDebug,
    finalistReviewSource,
    finalistReviewResults,
    rejectionSummaries,
    selectedSymbol,
    scannedTiers = ["tier1"],
    winningTier = null,
    tierSummaries = [],
    finalNoTradeExplanation = null,
  } = params;
  const finalRankingDebugWithOutcome = finalRankingDebug.map((item) => ({
    ...item,
    confirmedFinalSelection: selectedSymbol !== null && item.symbol === selectedSymbol,
  }));
  const stage3Passed = stage3Evaluations.flatMap((item) => (item.candidate ? [item.candidate] : []));
  const stage3NearMissCandidates: Stage3NearMiss[] = [];

  for (const evaluation of stage3Evaluations) {
    if (evaluation.pass) {
      continue;
    }

    const hardFailReasons = evaluation.issueBreakdown.hardVetoes ?? [];
    const softIssueReasons = evaluation.issueBreakdown.softIssues ?? [];
    const infoReasons = evaluation.issueBreakdown.info ?? [];

    stage3NearMissCandidates.push({
      symbol: evaluation.symbol,
      direction: evaluation.direction,
      score: evaluation.reviewScore,
      hardFailReasons,
      softIssueReasons,
      infoReasons,
      failReasons: [...hardFailReasons, ...softIssueReasons, ...infoReasons],
      roomToTargetDiagnostics: evaluation.roomToTargetDiagnostics,
    });
  }

  const listConsistencyWarnings: string[] = [];
  const stage1Set = new Set(stage1Passed.map((candidate) => candidate.symbol));
  const stage2Set = new Set(stage2Passed.map((candidate) => candidate.symbol));
  const stage3Set = new Set(stage3Passed.map((candidate) => candidate.symbol));
  const rankingSet = new Set(ranked.map((candidate) => candidate.symbol));
  const continuationEligibleSet = new Set(finalistReviewSource.continuationEligibleFinalists.map((candidate) => candidate.symbol));
  const confirmationEligibleSet = new Set(finalistReviewSource.confirmationEligibleFinalists.map((candidate) => candidate.symbol));
  const finalistsSet = new Set(finalistReviewSource.finalists.map((candidate) => candidate.symbol));

  for (const symbol of stage2Set) {
    if (!stage1Set.has(symbol)) {
      listConsistencyWarnings.push(`Stage 2 passed symbol ${symbol} is missing from Stage 1 passed list.`);
    }
  }
  for (const symbol of stage3Set) {
    if (!stage2Set.has(symbol)) {
      listConsistencyWarnings.push(`Stage 3 passed symbol ${symbol} is missing from Stage 2 passed list.`);
    }
  }
  for (const symbol of rankingSet) {
    if (!stage3Set.has(symbol)) {
      listConsistencyWarnings.push(`Final ranking symbol ${symbol} is missing from Stage 3 passed list.`);
    }
  }
  for (const symbol of continuationEligibleSet) {
    if (!rankingSet.has(symbol)) {
      listConsistencyWarnings.push(`Continuation-eligible finalist ${symbol} is missing from final ranking list.`);
    }
  }
  for (const symbol of confirmationEligibleSet) {
    if (!rankingSet.has(symbol)) {
      listConsistencyWarnings.push(`Confirmation-eligible finalist ${symbol} is missing from final ranking list.`);
    }
  }
  for (const symbol of finalistsSet) {
    if (!rankingSet.has(symbol)) {
      listConsistencyWarnings.push(`Finalists reviewed symbol ${symbol} is missing from final ranking list.`);
    }
  }

  const nearMisses = stage3NearMissCandidates
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, 3);

  const noTradeReason = buildConsistentNoTradeReason(
    finalistReviewResults,
    stage3Passed.map((candidate) => candidate.symbol),
    ranked.map((candidate) => candidate.symbol),
  );

  const stageCounts: StarterUniverseStageCounts = {
    stage1Entered: stage1Entered.length,
    stage1Passed: stage1Passed.length,
    stage2Passed: stage2Passed.length,
    stage3Passed: stage3Passed.length,
    continuationEligibleFinalists: finalistReviewSource.continuationEligibleFinalists.length,
    confirmationEligibleFinalists: finalistReviewSource.confirmationEligibleFinalists.length,
    finalistsReviewed: finalistReviewResults.length > 0 ? finalistReviewResults.length : finalistReviewSource.finalists.length,
    finalRanking: ranked.length,
  };
  const stageSymbols: StarterUniverseStageSymbols = {
    stage1Entered,
    stage1Passed: stage1Passed.map((candidate) => candidate.symbol),
    stage2Passed: stage2Passed.map((candidate) => candidate.symbol),
    stage3Passed: stage3Passed.map((candidate) => candidate.symbol),
    continuationEligibleFinalists: finalistReviewSource.continuationEligibleFinalists.map((candidate) => candidate.symbol),
    confirmationEligibleFinalists: finalistReviewSource.confirmationEligibleFinalists.map((candidate) => candidate.symbol),
    finalistsReviewed: finalistReviewResults.length > 0 ? finalistReviewResults.map((item) => item.symbol) : finalistReviewSource.finalists.map((candidate) => candidate.symbol),
    finalRanking: ranked.map((candidate) => candidate.symbol),
  };
  const resolvedTierSummaries: TierSummary[] = tierSummaries.length > 0
    ? tierSummaries
    : [{
        tier: scannedTiers[0] ?? "tier1",
        label: "Tier 1",
        description: "Current core universe of liquid optionable leaders and key ETFs.",
        counts: stageCounts,
        symbols: stageSymbols,
        finalistsReviewed: stageSymbols.finalistsReviewed,
        concludedWith: selectedSymbol ? "confirmed" : "no_trade_today",
        winner: selectedSymbol,
        noTradeReason: selectedSymbol ? null : noTradeReason.reason,
      }];
  const tierStageCounts = Object.fromEntries(resolvedTierSummaries.map((summary) => [summary.tier, summary.counts]));
  const tierFinalistsReviewed = Object.fromEntries(resolvedTierSummaries.map((summary) => [summary.tier, summary.finalistsReviewed]));
  const tierSummary = resolvedTierSummaries[0];
  const reviewedFinalistOutcomes: ReviewedFinalistOutcome[] = finalistReviewResults.map((item) => ({
    symbol: item.symbol,
    tier: tierSummary?.tier ?? scannedTiers[0] ?? "tier1",
    tierLabel: tierSummary?.label ?? "Tier 1",
    direction: item.direction,
    confidence: item.confidence,
    confirmationFailureReasons: item.confirmationFailureReasons,
    rankingScore: item.rankingScore,
    conclusion: item.conclusion,
    reason: item.reason,
  }));

  return {
    stageCounts,
    stageSymbols,
    finalistsReviewedDebug: finalistReviewSource.debug,
    stage3PassedDetails: stage3Passed.map((candidate) => ({
      symbol: candidate.symbol,
      direction: candidate.chartDirection,
      score: scoreStage3Candidate(candidate),
      summary: candidate.chartReviewSummary,
      whyPassed: `${summarizePassingChecks(candidate.chartDiagnostics.checks)} | failed=${summarizeFailedChecksByImpact(candidate.chartDiagnostics.checks)}`,
    })),
    finalRankingDebug: finalRankingDebugWithOutcome,
    rejectionSummaries,
    nearMisses,
    consistencyChecks: [...finalistReviewSource.warnings, ...listConsistencyWarnings, ...noTradeReason.symbolConsistencyWarnings],
    finalSelectedSymbol: selectedSymbol,
    topRankedSymbol: ranked[0]?.symbol ?? null,
    scannedTiers,
    winningTier,
    tierSummaries: resolvedTierSummaries,
    tierStageCounts,
    tierFinalistsReviewed,
    cumulativeStageCounts: stageCounts,
    finalNoTradeExplanation,
    reviewedFinalistOutcomes,
    bestReviewedFinalistsAcrossTiers: reviewedFinalistOutcomes.map((item) => item.symbol),
    bestRejectedCandidates: reviewedFinalistOutcomes.map((item) => ({
      symbol: item.symbol,
      tier: item.tier,
      tierLabel: item.tierLabel,
      rejectionReasons: item.confirmationFailureReasons,
    })),
    crossTierFinalistSummary: reviewedFinalistOutcomes.length > 0
      ? buildFinalistNoTradeReasonPath(finalistReviewResults)
      : null,
  };
}

function buildFinalistReviewSource(
  ranked: (ChartCandidate & { score: number })[],
  stage2PassedSymbols: string[],
  stage3PassedSymbols: string[],
): FinalistReviewSource {
  const continuationEligibleFinalists = ranked.filter((candidate) => getStage3CheckPass(candidate, "continuation"));
  const confirmationEligibleFinalists = continuationEligibleFinalists.filter((candidate) => getStage3CheckPass(candidate, "higher-timeframe-2r-viability"));
  const finalists = confirmationEligibleFinalists;
  const stage2Set = new Set(stage2PassedSymbols);
  const stage3Set = new Set(stage3PassedSymbols);
  const debug: StarterUniverseTelemetry["finalistsReviewedDebug"] = [];
  const warnings: string[] = [];

  for (const finalist of ranked) {
    const inStage2Passed = stage2Set.has(finalist.symbol);
    const inStage3Passed = stage3Set.has(finalist.symbol);
    const sourceList: "stage3Passed" | "stage2PassedOnly" | "missingUpstream" = inStage3Passed
      ? "stage3Passed"
      : inStage2Passed
      ? "stage2PassedOnly"
      : "missingUpstream";

    const upstreamConsistencyOk = inStage3Passed;
    const upstreamConsistencyWarning = upstreamConsistencyOk
      ? null
      : `Finalist ${finalist.symbol} was reviewed but missing from Stage 3 passed source list.`;
    if (upstreamConsistencyWarning) {
      warnings.push(upstreamConsistencyWarning);
    }

    debug.push({
      symbol: finalist.symbol,
      eligibleForReviewReason: !getStage3CheckPass(finalist, "continuation")
        ? `Stage 3 pass-through candidate excluded from deterministic confirmation review because continuationPass=false (${finalist.score.toFixed(2)}).`
        : getStage3CheckPass(finalist, "higher-timeframe-2r-viability")
        ? `Stage 3 continuation-pass finalist eligible for deterministic confirmation review because higher-timeframe-2r-viability=true (${finalist.score.toFixed(2)}).`
        : `Stage 3 continuation-pass finalist excluded from deterministic confirmation review because higher-timeframe-2r-viability=false (${finalist.score.toFixed(2)}).`,
      sourceList,
      inStage2Passed,
      inStage3Passed,
      upstreamConsistencyOk,
      upstreamConsistencyWarning,
    });
  }

  return { continuationEligibleFinalists, confirmationEligibleFinalists, finalists, debug, warnings };
}

function buildFinalRanking(stage3Passed: ChartCandidate[]): { ranked: (ChartCandidate & { score: number })[]; debug: FinalRankingEntry[] } {
  const debug = stage3Passed.map((candidate) => {
    const computedScore = scoreStage3Candidate(candidate);
    const score = Number.isFinite(computedScore) ? computedScore : null;
    const continuationPenalty = getStage3ContinuationPenalty(candidate);
    const scoreInputs = {
      movePct: candidate.chartMovePct,
      optionOpenInterest: candidate.optionOpenInterest,
      optionSpread: candidate.optionSpread,
      optionMid: candidate.optionMid,
      volumeRatio: candidate.volumeRatio,
      chartReviewScore: candidate.chartReviewScore,
      continuationPass: getStage3CheckPass(candidate, "continuation"),
      continuationPenalty,
    };

    if (score === null) {
      return {
        symbol: candidate.symbol,
        direction: candidate.chartDirection,
        score,
        enteredFinalRanking: false,
        topRankedCandidate: false,
        confirmedFinalSelection: false,
        selected: false,
        selectedFieldMeaning: "legacy_top_ranked_candidate_not_confirmed_trade",
        reason: "missing final score",
        scoreInputs,
      };
    }

    return {
      symbol: candidate.symbol,
      direction: candidate.chartDirection,
      score,
      enteredFinalRanking: true,
      topRankedCandidate: false,
      confirmedFinalSelection: false,
      selected: false,
      selectedFieldMeaning: "legacy_top_ranked_candidate_not_confirmed_trade",
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
      item.topRankedCandidate = true;
      item.selected = true;
      item.reason = "top-ranked candidate after deterministic tie-breaks";
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
      `[scanner:debug] ${item.symbol}: dir=${item.direction} | score=${score} | enteredFinalRanking=${item.enteredFinalRanking ? "yes" : "no"} | topRankedCandidate=${item.topRankedCandidate ? "yes" : "no"} | confirmedFinalSelection=${item.confirmedFinalSelection ? "yes" : "no"} | reason=${item.reason} | inputs=${JSON.stringify(item.scoreInputs)}`,
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

  console.log("[scanner:debug] Stage 3 pass-through and top-ranked candidate:");
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
    const topRankedCandidate = rankingEntry?.topRankedCandidate ?? rankingEntry?.selected ?? false;
    const rankingScore = rankingEntry?.score === null || rankingEntry?.score === undefined ? "n/a" : rankingEntry.score.toFixed(2);
    const reason = rankingEntry?.reason ?? "not evaluated in final ranking";

    console.log(
      `[scanner:debug] ${candidate.symbol}: stage3Pass=yes | enteredFinalRanking=${enteredFinalRanking ? "yes" : "no"} | rankingScore=${rankingScore} | rankingThreshold=${thresholdLabel} | topRankedCandidate=${topRankedCandidate ? "yes" : "no"} | reason=${reason}`,
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
    const roomDetails = finalist.stage3Inputs?.roomToTargetDecision ?? "n/a";
    const failureReasons = finalist.confirmationFailureReasons.length > 0 ? finalist.confirmationFailureReasons.join("; ") : "none";
    console.log(
      `[scanner:debug] ${finalist.symbol}: dir=${finalist.direction ?? "n/a"} | status=${finalist.reviewStatus}/${finalist.confirmationStatus} | confidence=${finalist.confidence ?? "n/a"} | failureReasons=${failureReasons} | rankingScore=${finalist.rankingScore.toFixed(2)} | reviewConclusion=${finalist.conclusion} | selected=${selected} | room2R=${roomDetails} | reviewReason=${finalist.reason} | inputs=${JSON.stringify(stageInputs)}`,
    );
  }
}

function formatFinalistReasonList(reasons: string[]): string {
  if (reasons.length === 0) {
    return "unspecified confirmation failure";
  }

  if (reasons.length === 1) {
    return reasons[0] ?? "unspecified confirmation failure";
  }

  return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
}

function buildFinalistNoTradeReasonPath(finalists: FinalistReviewResult[]): string {
  const reviewed = finalists
    .map(
      (item) =>
        `${item.symbol} (${item.direction ?? "n/a"}, ${item.reviewStatus}/${item.confirmationStatus}, confidence=${item.confidence ?? "n/a"}, reasons: ${formatFinalistReasonList(item.confirmationFailureReasons)})`,
    )
    .join("; ");

  const narrative = finalists
    .map((item) => `${item.symbol} was shortlisted but failed final confirmation due to ${formatFinalistReasonList(item.confirmationFailureReasons)}.`)
    .join(" ");

  return `Ranked finalists were reviewed in deterministic order and all were rejected (${finalists.map((item) => item.symbol).join(", ")}). Reason path: ${narrative} Finalist outcomes: ${reviewed}.`;
}

function summarizeCrossTierRejectionReasons(finalists: ReviewedFinalistOutcome[]): string {
  const counts = new Map<string, number>();

  for (const finalist of finalists) {
    for (const reason of finalist.confirmationFailureReasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }

  const rankedReasons = [...counts.entries()]
    .sort((a, b) => {
      const countDelta = b[1] - a[1];
      if (countDelta !== 0) {
        return countDelta;
      }

      return a[0].localeCompare(b[0]);
    })
    .slice(0, 3)
    .map(([reason, count]) => `${reason} (${count})`);

  return rankedReasons.length > 0 ? rankedReasons.join(", ") : "unspecified confirmation failure";
}

function selectBestReviewedFinalistsAcrossTiers(finalists: ReviewedFinalistOutcome[]): ReviewedFinalistOutcome[] {
  const bestBySymbol = new Map<string, ReviewedFinalistOutcome>();

  for (const finalist of finalists) {
    const existing = bestBySymbol.get(finalist.symbol);
    if (!existing || finalist.rankingScore > existing.rankingScore) {
      bestBySymbol.set(finalist.symbol, finalist);
    }
  }

  return [...bestBySymbol.values()]
    .sort((a, b) => {
      const tierDelta = SCAN_UNIVERSE_TIERS.findIndex((tier) => tier.key === a.tier) - SCAN_UNIVERSE_TIERS.findIndex((tier) => tier.key === b.tier);
      if (tierDelta !== 0) {
        return tierDelta;
      }

      const scoreDelta = b.rankingScore - a.rankingScore;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, 5);
}

function buildCrossTierNoTradeSummary(executions: TierScanExecution[]): {
  finalNoTradeExplanation: string;
  reviewedFinalistOutcomes: ReviewedFinalistOutcome[];
  bestReviewedFinalistsAcrossTiers: string[];
  bestRejectedCandidates: StarterUniverseTelemetry["bestRejectedCandidates"];
  crossTierFinalistSummary: string | null;
} {
  if (executions.length === 0) {
    return {
      finalNoTradeExplanation: "No tiers were scanned.",
      reviewedFinalistOutcomes: [],
      bestReviewedFinalistsAcrossTiers: [],
      bestRejectedCandidates: [],
      crossTierFinalistSummary: null,
    };
  }

  const reviewedFinalistOutcomes = executions.flatMap((item) => item.telemetry.reviewedFinalistOutcomes);
  const tierLabels = executions.map((item) => item.tier.label).join(", ");

  if (reviewedFinalistOutcomes.length === 0) {
    const finalTierReason = executions.at(-1)?.result.reason ?? "no_trade_today";
    return {
      finalNoTradeExplanation: `No confirmed setup survived across scanned tiers (${tierLabels}). ${finalTierReason}`,
      reviewedFinalistOutcomes,
      bestReviewedFinalistsAcrossTiers: [],
      bestRejectedCandidates: [],
      crossTierFinalistSummary: null,
    };
  }

  const bestReviewedFinalists = selectBestReviewedFinalistsAcrossTiers(reviewedFinalistOutcomes);
  const bestRejectedCandidates = bestReviewedFinalists.map((item) => ({
    symbol: item.symbol,
    tier: item.tier,
    tierLabel: item.tierLabel,
    rejectionReasons: item.confirmationFailureReasons,
  }));
  const reviewedTierLabels = [...new Set(bestReviewedFinalists.map((item) => item.tierLabel))];
  const reviewedReasons = summarizeCrossTierRejectionReasons(bestReviewedFinalists);
  const terminalTierReason = executions.at(-1)?.result.reason ?? null;
  const terminalTierSuffix = terminalTierReason && !bestReviewedFinalists.some((item) => terminalTierReason.includes(item.symbol))
    ? ` ${executions.at(-1)?.tier.label} also ended with: ${terminalTierReason}`
    : "";
  const crossTierFinalistSummary = `The closest reviewed candidates were ${bestReviewedFinalists.map((item) => `${item.symbol} (${item.tierLabel})`).join(", ")}, but each failed final confirmation due to ${reviewedReasons}.`;

  return {
    finalNoTradeExplanation: `No confirmed setup survived across scanned tiers (${tierLabels}). ${crossTierFinalistSummary}${terminalTierSuffix}`,
    reviewedFinalistOutcomes,
    bestReviewedFinalistsAcrossTiers: bestReviewedFinalists.map((item) => item.symbol),
    bestRejectedCandidates,
    crossTierFinalistSummary: `${crossTierFinalistSummary} Reviewed finalists came from ${reviewedTierLabels.join(", ")}.`,
  };
}

function buildGenericNoTradeReason(stage3PassedCount: number, finalRankingCount: number, finalistsReviewedCount: number): string {
  if (stage3PassedCount === 0 && finalRankingCount === 0 && finalistsReviewedCount === 0) {
    return "No ranked finalists existed because no symbols passed Stage 3 chart/bar review.";
  }

  if (finalRankingCount === 0) {
    return "No ranked finalists existed after final scoring.";
  }

  if (finalistsReviewedCount === 0) {
    return "No continuation-pass Stage 3 finalists with higher-timeframe 2R viability remained for immediate-entry confirmation review.";
  }

  return "Ranked finalists were reviewed in deterministic order and all were rejected.";
}

function collectMentionedUniverseSymbols(reason: string): string[] {
  const mentioned = reason.match(/\b[A-Z]{1,5}\b/g) ?? [];
  const universe = new Set<string>(ALL_SCAN_UNIVERSE_SET);
  return [...new Set(mentioned.filter((symbol) => universe.has(symbol)))];
}

function getReasonSymbolConsistencyWarnings(reason: string, approvedSymbols: Set<string>): string[] {
  const mentionedSymbols = collectMentionedUniverseSymbols(reason);
  return mentionedSymbols
    .filter((symbol) => !approvedSymbols.has(symbol))
    .map((symbol) => `scan.reason mentions symbol ${symbol} that is absent from finalistsReviewed/stage3Passed source-of-truth lists.`);
}

function buildConsistentNoTradeReason(
  finalists: FinalistReviewResult[],
  stage3PassedSymbols: string[],
  finalRankingSymbols: string[],
): { reason: string; symbolConsistencyWarnings: string[] } {
  const fallbackReason = buildGenericNoTradeReason(stage3PassedSymbols.length, finalRankingSymbols.length, finalists.length);
  if (finalists.length === 0) {
    return { reason: fallbackReason, symbolConsistencyWarnings: [] };
  }

  const detailedReason = buildFinalistNoTradeReasonPath(finalists);
  const approvedSymbols = new Set([...stage3PassedSymbols, ...finalRankingSymbols, ...finalists.map((item) => item.symbol)]);
  const symbolConsistencyWarnings = getReasonSymbolConsistencyWarnings(detailedReason, approvedSymbols);
  if (symbolConsistencyWarnings.length > 0) {
    return { reason: fallbackReason, symbolConsistencyWarnings };
  }

  return { reason: detailedReason, symbolConsistencyWarnings: [] };
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
        issueBreakdown: { hardVetoes: ["failed to load required multi-timeframe bars"], softIssues: [], info: [] },
        roomToTargetDiagnostics: null,
      });
      continue;
    }

    const review = runStage3ChartReview(multiTimeframeBars, timeframeDiagnostics);
    const issueBreakdown = getStage3IssueBreakdown(review);
    const hasHardVeto = issueBreakdown.hardVetoes.length > 0;
    const pass = !!review.direction && !hasHardVeto;

    if (!pass) {
      const failReason = getStage3FailReasons(review)[0] ?? "other";
      evaluations.push({
        symbol: candidate.symbol,
        pass: false,
        candidate: null,
        direction: review.direction ?? "none",
        reviewScore: review.score,
        summary: review.summary,
        rejectionReason: failReason,
        issueBreakdown,
        roomToTargetDiagnostics: review.diagnostics.roomToTargetDiagnostics,
      });
      if (process.env.SCANNER_DEBUG === "1") {
        console.log(
          `[scanner:debug:stage3] ${candidate.symbol}: near-miss detail | hardVetoes=${issueBreakdown.hardVetoes.length > 0 ? issueBreakdown.hardVetoes.join("; ") : "none"} | softIssues=${issueBreakdown.softIssues.length > 0 ? issueBreakdown.softIssues.join("; ") : "none"} | ${describeRoomToTargetDecision(review.diagnostics.roomToTargetDiagnostics)} | failedChecks=${summarizeFailedChecksByImpact(review.diagnostics.checks)}`,
        );
      }
      continue;
    }

    const direction = review.direction as ScanDirection;
    evaluations.push({
      symbol: candidate.symbol,
      pass: true,
      candidate: {
        ...candidate,
        chartDirection: direction,
        chartMovePct: review.movePct,
        volumeRatio: review.volumeRatio,
        chartReviewSummary: review.summary,
        chartReviewScore: review.score,
        chartDiagnostics: review.diagnostics,
      },
      direction,
      reviewScore: review.score,
      summary: review.summary,
      rejectionReason: null,
      issueBreakdown,
      roomToTargetDiagnostics: review.diagnostics.roomToTargetDiagnostics,
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
  return ALL_SCAN_UNIVERSE_SET.has(symbol.toUpperCase());
}

function logGeneralScanDebug(stage: string, symbols: string[]): void {
  if (process.env.SCANNER_DEBUG !== "1") {
    return;
  }

  if (symbols.length === 0) {
    console.log(`[scanner:debug] ${stage}: (none)`);
    return;
  }

  const isVerbose = process.env.SCANNER_DEBUG_VERBOSE === "1";
  if (isVerbose) {
    console.log(`[scanner:debug] ${stage}: ${symbols.join(", ")}`);
    return;
  }

  const preview = symbols.slice(0, 20).join(", ");
  const remaining = symbols.length - 20;
  const suffix = remaining > 0 ? ` ... (+${remaining} more, set SCANNER_DEBUG_VERBOSE=1 for full list)` : "";
  console.log(`[scanner:debug] ${stage} (${symbols.length}): ${preview}${suffix}`);
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

function categorizeStage3IssueSeverity(check: string, review?: ChartReviewResult): Stage3IssueSeverity {
  if (check === "failed-breakout-trap" || check === "alignment") {
    return "hard_veto";
  }

  if (check === "higher-timeframe-2r-viability") {
    return review?.diagnostics.roomToTargetDiagnostics.decisionMode === "hard_fail" ? "hard_veto" : "score_penalty";
  }

  if (check === "volume-data" || check === "higher-timeframe-context") {
    return "info";
  }

  return "score_penalty";
}

function formatStage3IssueReason(check: string, reason: string, review: ChartReviewResult): string {
  if (check === "failed-breakout-trap") {
    return `bull/bear trap risk (${reason})`;
  }
  if (check === "higher-timeframe-2r-viability") {
    return `2R room tight (${describeRoomToTargetDecision(review.diagnostics.roomToTargetDiagnostics)})`;
  }
  if (check === "alignment") {
    return `directional misalignment (${reason})`;
  }
  if (check === "expansion") {
    return `weak expansion (${reason})`;
  }
  if (check === "impulse-consolidation") {
    return `impulse/hold quality issue (${reason})`;
  }
  if (check === "fake-hold-distribution") {
    return `distribution risk (${reason})`;
  }
  if (check === "continuation") {
    return `rejection risk (${reason})`;
  }
  if (check === "volume") {
    return `weak volume (${reason})`;
  }
  return `${check} (${reason})`;
}

function getStage3IssueBreakdown(review: ChartReviewResult): Stage3IssueBreakdown {
  const breakdown: Stage3IssueBreakdown = { hardVetoes: [], softIssues: [], info: [] };

  for (const check of review.diagnostics.checks) {
    if (check.pass) {
      continue;
    }

    const severity = categorizeStage3IssueSeverity(check.check, review);
    const reason = formatStage3IssueReason(check.check, check.reason, review);

    if (severity === "hard_veto") {
      breakdown.hardVetoes.push(reason);
      continue;
    }

    if (severity === "score_penalty") {
      breakdown.softIssues.push(reason);
      continue;
    }

    breakdown.info.push(reason);
  }

  return breakdown;
}

function getStage3FailReasons(review: ChartReviewResult): string[] {
  const issueBreakdown = getStage3IssueBreakdown(review);
  const reasons = [...issueBreakdown.hardVetoes];

  if (reasons.length === 0 && issueBreakdown.softIssues.length > 0) {
    reasons.push(issueBreakdown.softIssues[0] ?? "other");
  }

  if (reasons.length === 0 && issueBreakdown.info.length > 0) {
    reasons.push(issueBreakdown.info[0] ?? "other");
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
  const continuationPenalty = getStage3ContinuationPenalty(candidate);
  return moveScore + oiScore + spreadScore + volumeScore + candidate.chartReviewScore - continuationPenalty;
}

function getStage3CheckPass(candidate: ChartCandidate, check: string): boolean {
  return !!candidate.chartDiagnostics.checks.find((item) => item.check === check)?.pass;
}

function getStage3ContinuationPenalty(candidate: ChartCandidate): number {
  if (getStage3CheckPass(candidate, "continuation")) {
    return 0;
  }

  let penalty = 2.5;
  if (!getStage3CheckPass(candidate, "impulse-consolidation")) {
    penalty += 0.5;
  }
  if (!getStage3CheckPass(candidate, "fake-hold-distribution")) {
    penalty += 0.5;
  }
  if (!getStage3CheckPass(candidate, "volume")) {
    penalty += 0.5;
  }

  return penalty;
}

function summarizePassingChecks(checks: Stage3CheckDiagnostic[]): string {
  const passingChecks = checks.filter((check) => check.pass).map((check) => check.check);
  return passingChecks.length > 0 ? passingChecks.join(", ") : "no failed checks";
}

function summarizeFailedChecksByImpact(checks: Stage3CheckDiagnostic[]): string {
  const failedChecks = checks.filter((check) => !check.pass);
  if (failedChecks.length === 0) {
    return "no failed checks";
  }

  return failedChecks.map((check) => `${check.check}:${check.impact}`).join(", ");
}

function summarizeCheckOutcomes(checks: Stage3CheckDiagnostic[]): string {
  return checks.map((check) => `${check.check}:${check.pass ? "pass" : `fail/${check.impact}`}`).join(", ");
}

function describeRoomToTargetDecision(
  diagnostics: Stage3Diagnostics["roomToTargetDiagnostics"],
): string {
  const levelLabel = diagnostics.levelUsed === null ? "n/a" : diagnostics.levelUsed.toFixed(2);
  const roomLabel = diagnostics.roomPct === null ? "n/a" : `${diagnostics.roomPct.toFixed(2)}%`;
  const roomStatus = diagnostics.sufficientRoom ? "sufficient" : "insufficient";

  return `2R room check -> ref=${diagnostics.referencePrice.toFixed(2)}, dir=${diagnostics.direction}, level=${levelLabel}, room=${roomLabel}, tier=${diagnostics.roomTier}, assumption=${diagnostics.targetAssumption}, decision=${diagnostics.decisionMode}, status=${roomStatus}, reason=${diagnostics.insufficientRoomReason}`;
}

function getCheckImpactLabel(
  check: string,
  volumeRatio: number | null,
): Stage3CheckDiagnostic["impact"] {
  if (check === "alignment" || check === "failed-breakout-trap" || check === "higher-timeframe-2r-viability") {
    return "blocker";
  }

  if (check === "volume") {
    return volumeRatio !== null && volumeRatio >= 0.8 ? "mild_caution" : "downgrader";
  }

  if (check === "volume-data" || check === "higher-timeframe-context") {
    return "mild_caution";
  }

  return "downgrader";
}

function getConfirmationSoftIssueMetrics(review: ChartReviewResult): {
  checkByName: Map<string, Stage3CheckDiagnostic>;
  hasWeakExpansion: boolean;
  hasVolumeIssue: boolean;
  hasTriggerZoneIssue: boolean;
  hasChoppyIssue: boolean;
  volumeRatio: number | null;
  volumeIssueWeight: number;
  structuralWeaknessWeight: number;
  expansionWeight: number;
  overlappingPriceActionDrag: number;
  weightedSoftIssueScore: number;
} {
  const checkByName = new Map(review.diagnostics.checks.map((item) => [item.check, item]));
  const hasWeakExpansion = !checkByName.get("expansion")?.pass;
  const hasBodyWickIssue = !checkByName.get("body-wick")?.pass;
  const hasContinuationIssue = !checkByName.get("continuation")?.pass;
  const hasImpulseConsolidationIssue = !checkByName.get("impulse-consolidation")?.pass;
  const hasDistributionIssue = !checkByName.get("fake-hold-distribution")?.pass;
  const hasTriggerZoneIssue = !checkByName.get("trigger-zone-flips")?.pass;
  const hasChoppyIssue = !checkByName.get("choppy")?.pass;
  const hasVolumeIssue = !checkByName.get("volume")?.pass;
  const volumeRatio = review.volumeRatio;
  const volumeIssueWeight = hasVolumeIssue
    ? volumeRatio === null
      ? 0.45
      : volumeRatio >= 0.8
        ? 0.35
        : volumeRatio >= 0.7
          ? 0.65
          : 1
    : 0;
  const structuralWeaknessWeight =
    (hasBodyWickIssue ? 0.75 : 0) +
    (hasContinuationIssue ? 1.1 : 0) +
    (hasImpulseConsolidationIssue ? 0.75 : 0) +
    (hasDistributionIssue ? 0.9 : 0) +
    (hasTriggerZoneIssue ? 0.45 : 0) +
    (hasChoppyIssue && !hasTriggerZoneIssue ? 0.25 : 0);
  const expansionWeight = hasWeakExpansion ? 0.25 : 0;
  const overlappingPriceActionDrag = hasTriggerZoneIssue && hasChoppyIssue ? -0.2 : 0;
  const weightedSoftIssueScore = structuralWeaknessWeight + volumeIssueWeight + expansionWeight + overlappingPriceActionDrag;

  return {
    checkByName,
    hasWeakExpansion,
    hasVolumeIssue,
    hasTriggerZoneIssue,
    hasChoppyIssue,
    volumeRatio,
    volumeIssueWeight,
    structuralWeaknessWeight,
    expansionWeight,
    overlappingPriceActionDrag,
    weightedSoftIssueScore,
  };
}

function resolveConfirmationOutcome(review: ChartReviewResult): { conclusion: ScanResult["conclusion"]; confidence: ScanConfidence | null } {
  if (!review.direction) {
    return { conclusion: "rejected", confidence: null };
  }

  const issueBreakdown = getStage3IssueBreakdown(review);
  if (issueBreakdown.hardVetoes.length > 0) {
    return { conclusion: "rejected", confidence: null };
  }

  const {
    checkByName,
    volumeIssueWeight,
    structuralWeaknessWeight,
    weightedSoftIssueScore,
  } = getConfirmationSoftIssueMetrics(review);

  if (weightedSoftIssueScore >= 3) {
    return { conclusion: "rejected", confidence: null };
  }

  if (structuralWeaknessWeight >= 2.4 && volumeIssueWeight >= 1) {
    return { conclusion: "rejected", confidence: null };
  }

  if (!review.pass && weightedSoftIssueScore >= 2.35) {
    return { conclusion: "rejected", confidence: null };
  }

  const supportsClean2RStructure =
    !!checkByName.get("continuation")?.pass &&
    !!checkByName.get("higher-timeframe-room")?.pass &&
    !!checkByName.get("higher-timeframe-2r-viability")?.pass;

  if (!supportsClean2RStructure) {
    return { conclusion: "rejected", confidence: null };
  }

  const confidence: ScanConfidence = review.score >= 11 ? "85-92" : review.score >= 9 ? "75-84" : "65-74";
  if (confidence === "65-74") {
    return { conclusion: "rejected", confidence: null };
  }

  return { conclusion: "confirmed", confidence };
}

function getConfirmationStructureDebug(review: ChartReviewResult): {
  continuationPass: boolean;
  higherTimeframeRoomPass: boolean;
  higherTimeframe2RPass: boolean;
  supportsTradable2RStructure: boolean;
  topBlockingReasons: string[];
} {
  const checkByName = new Map(review.diagnostics.checks.map((item) => [item.check, item]));
  const continuationPass = !!checkByName.get("continuation")?.pass;
  const higherTimeframeRoomPass = !!checkByName.get("higher-timeframe-room")?.pass;
  const higherTimeframe2RPass = !!checkByName.get("higher-timeframe-2r-viability")?.pass;
  const topBlockingReasons: string[] = [];

  if (!continuationPass) {
    topBlockingReasons.push("continuation failed");
  }
  if (!higherTimeframeRoomPass) {
    topBlockingReasons.push("higher-timeframe room failed");
  }
  if (!higherTimeframe2RPass) {
    topBlockingReasons.push("higher-timeframe 2R viability failed");
  }

  return {
    continuationPass,
    higherTimeframeRoomPass,
    higherTimeframe2RPass,
    supportsTradable2RStructure: continuationPass && higherTimeframeRoomPass && higherTimeframe2RPass,
    topBlockingReasons,
  };
}

function buildConfirmationDebug(
  review: ChartReviewResult | null,
  confirmationStatus: "confirmed" | "rejected",
  confirmationFailureReasons: string[],
  overrides?: Partial<Pick<ConfirmationDebug, "reviewStatus" | "topBlockingReasons">>,
): ConfirmationDebug {
  const defaultStructure = {
    continuationPass: false,
    higherTimeframeRoomPass: false,
    higherTimeframe2RPass: false,
    supportsTradable2RStructure: false,
    topBlockingReasons: confirmationFailureReasons.length > 0 ? [...confirmationFailureReasons] : [],
    weightedSoftIssueScore: 0,
    rejectedBecauseConfidenceBelow75: false,
  };

  if (!review) {
    return {
      reviewStatus: overrides?.reviewStatus ?? "reviewed",
      confirmationStatus,
      confirmationFailureReasons,
      continuationPass: defaultStructure.continuationPass,
      higherTimeframeRoomPass: defaultStructure.higherTimeframeRoomPass,
      higherTimeframe2RPass: defaultStructure.higherTimeframe2RPass,
      supportsTradable2RStructure: defaultStructure.supportsTradable2RStructure,
      rejectedBecauseConfidenceBelow75: defaultStructure.rejectedBecauseConfidenceBelow75,
      weightedSoftIssueScore: defaultStructure.weightedSoftIssueScore,
      topBlockingReasons: overrides?.topBlockingReasons ?? defaultStructure.topBlockingReasons,
    };
  }

  const { weightedSoftIssueScore } = getConfirmationSoftIssueMetrics(review);
  const structureDebug = getConfirmationStructureDebug(review);
  const confidence: ScanConfidence = review.score >= 11 ? "85-92" : review.score >= 9 ? "75-84" : "65-74";

  return {
    reviewStatus: overrides?.reviewStatus ?? "reviewed",
    confirmationStatus,
    confirmationFailureReasons,
    continuationPass: structureDebug.continuationPass,
    higherTimeframeRoomPass: structureDebug.higherTimeframeRoomPass,
    higherTimeframe2RPass: structureDebug.higherTimeframe2RPass,
    supportsTradable2RStructure: structureDebug.supportsTradable2RStructure,
    rejectedBecauseConfidenceBelow75: confirmationStatus === "rejected" && confidence === "65-74",
    weightedSoftIssueScore,
    topBlockingReasons: overrides?.topBlockingReasons ?? (structureDebug.topBlockingReasons.length > 0 ? structureDebug.topBlockingReasons : [...confirmationFailureReasons]),
  };
}

function getConfirmationRejectionReasons(review: ChartReviewResult): string[] {
  if (!review.direction) {
    return ["hard veto: directional context is unavailable"];
  }

  const issueBreakdown = getStage3IssueBreakdown(review);
  const {
    checkByName,
    hasWeakExpansion,
    hasVolumeIssue,
    hasTriggerZoneIssue,
    hasChoppyIssue,
    volumeRatio,
    volumeIssueWeight,
    structuralWeaknessWeight,
    expansionWeight,
    overlappingPriceActionDrag,
    weightedSoftIssueScore,
  } = getConfirmationSoftIssueMetrics(review);
  const nonExpansionSoftIssues = issueBreakdown.softIssues.filter((reason) => !reason.startsWith("weak expansion ("));
  const distinctNonExpansionSoftIssues = [...new Set(nonExpansionSoftIssues)];
  const topWeaknesses = distinctNonExpansionSoftIssues.slice(0, 4);

  if (issueBreakdown.hardVetoes.length > 0) {
    return [`hard veto: ${formatFinalistReasonList(issueBreakdown.hardVetoes)}`];
  }

  if (weightedSoftIssueScore >= 2.35 || structuralWeaknessWeight >= 2.4) {
    const volumeQualifier =
      hasVolumeIssue && volumeRatio !== null && volumeRatio >= 0.8
        ? `; mild volume caution (${volumeRatio.toFixed(2)}x) down-weighted`
        : "";
    const overlapQualifier = overlappingPriceActionDrag < 0 ? "; trigger-zone/chop overlap de-stacked" : "";
    return [`multiple confirmation weaknesses (overlap-aware): ${formatFinalistReasonList(topWeaknesses.length > 0 ? topWeaknesses : distinctNonExpansionSoftIssues)}${volumeQualifier}${overlapQualifier}`];
  }

  const confidence: ScanConfidence = review.score >= 11 ? "85-92" : review.score >= 9 ? "75-84" : "65-74";
  if (confidence === "65-74") {
    const expansionNarrative = hasWeakExpansion ? `; weak expansion remained only a soft drag (${checkByName.get("expansion")?.reason ?? "expansion ratio unavailable"}, weight=${expansionWeight.toFixed(2)})` : "";
    return [`confirmation score stayed below the 75 minimum (score=${review.score.toFixed(2)}, weightedSoftIssueScore=${weightedSoftIssueScore.toFixed(2)})${expansionNarrative}`];
  }

  const structureDebug = getConfirmationStructureDebug(review);
  if (!structureDebug.supportsTradable2RStructure) {
    if (structureDebug.topBlockingReasons.length === 1) {
      return [`clean 2:1 structure missing: ${structureDebug.topBlockingReasons[0]} before trade-card confirmation`];
    }

    return [
      `clean 2:1 structure missing: ${formatFinalistReasonList(structureDebug.topBlockingReasons)} before trade-card confirmation`,
    ];
  }

  return getStage3FailReasons(review);
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
  const bars1DForConfirmation = bars1D.length >= 2 ? bars1D.slice(0, -1) : bars1D;
  const bars1W = barsByView["1W"];
  const bars3M = barsByView["3M"];
  const bars1Y = barsByView["1Y"];

  const move1D = getMovePctFromBars(bars1DForConfirmation);
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
        roomToTargetDiagnostics: {
          referencePrice: 0,
          direction: "bullish",
          levelDetection: "n/a",
          levelStrength: "n/a",
          levelUsed: null,
          roomPct: null,
          targetAssumption: "2R requires roomPct >= 2.00%",
          decisionMode: "score_penalty",
          roomTier: "unknown",
          sufficientRoom: true,
          insufficientRoomReason: "No data because directional setup was not available.",
        },
        checks: [{ check: "data-integrity", pass: false, reason: "missing/incomplete bar data (1D or 1W close unavailable)", impact: "blocker" }],
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
        roomToTargetDiagnostics: {
          referencePrice: 0,
          direction: "bullish",
          levelDetection: "n/a",
          levelStrength: "n/a",
          levelUsed: null,
          roomPct: null,
          targetAssumption: "2R requires roomPct >= 2.00%",
          decisionMode: "score_penalty",
          roomTier: "unknown",
          sufficientRoom: true,
          insufficientRoomReason: "No data because directional setup was not available.",
        },
        checks: [{ check: "alignment", pass: false, reason: alignmentReason, impact: "blocker" }],
      },
    };
  }

  const lastBar = bars1DForConfirmation[bars1DForConfirmation.length - 1] ?? null;
  const priorBars = bars1DForConfirmation.slice(0, -1);
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
        roomToTargetDiagnostics: {
          referencePrice: 0,
          direction: "bullish",
          levelDetection: "n/a",
          levelStrength: "n/a",
          levelUsed: null,
          roomPct: null,
          targetAssumption: "2R requires roomPct >= 2.00%",
          decisionMode: "score_penalty",
          roomTier: "unknown",
          sufficientRoom: true,
          insufficientRoomReason: "No data because directional setup was not available.",
        },
        checks: [{ check: "data-integrity", pass: false, reason: "missing/incomplete bar data (latest 1D candle OHLC unavailable)", impact: "blocker" }],
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

  const expansionPass = expansionRatio === null || expansionRatio >= 1.1;
  const bodyQualityPass =
    direction === "bullish"
      ? bodyToRange >= 0.4 && closeLocation >= 0.58 && upperWick <= body * 1.15
      : bodyToRange >= 0.4 && closeLocation <= 0.42 && lowerWick <= body * 1.15;
  const volumePass = volumeRatio === null || volumeRatio >= 0.85;

  const consolidationBars = bars1DForConfirmation.slice(-5);
  const impulseBars = bars1DForConfirmation.slice(-11, -5);

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
        ? impulseMovePct >= 1
        : impulseMovePct <= -1;
  const consolidationTightPass =
    impulseAverageRange !== null && consolidationAverageRange !== null && impulseAverageRange > 0
      ? consolidationAverageRange <= impulseAverageRange * 0.95
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
    ? readNumber(bars1DForConfirmation[bars1DForConfirmation.length - 2] ?? null, ["High"])
    : readNumber(bars1DForConfirmation[bars1DForConfirmation.length - 2] ?? null, ["Low"]);
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

  const closes = bars1DForConfirmation.slice(-7).map((bar) => readNumber(bar, ["Close"]))
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

  const prevBar = bars1DForConfirmation[bars1DForConfirmation.length - 2] ?? null;
  const prevHigh = readNumber(prevBar, ["High"]);
  const prevLow = readNumber(prevBar, ["Low"]);
  const directionalClosePass = direction === "bullish" ? close >= open : close <= open;
  const triggerReference = direction === "bullish" ? prevHigh : prevLow;
  const triggerZoneBuffer = triggerReference === null ? null : Math.max(range * 0.2, close * 0.0025);
  const triggerZoneHoldPass =
    triggerReference === null || triggerZoneBuffer === null
      ? directionalClosePass
      : direction === "bullish"
        ? close >= triggerReference - triggerZoneBuffer
        : close <= triggerReference + triggerZoneBuffer;
  const decisiveBreakoutContinuationPass =
    direction === "bullish"
      ? prevHigh !== null && close > prevHigh && directionalClosePass
      : prevLow !== null && close < prevLow && directionalClosePass;
  const triggerZoneRejectionPass =
    direction === "bullish"
      ? closeLocation >= 0.5
      : closeLocation <= 0.5;
  const continuationFailureReasons: string[] = [];
  if (!directionalClosePass) {
    continuationFailureReasons.push("closed against the setup direction");
  }
  if (!triggerZoneHoldPass) {
    continuationFailureReasons.push(
      direction === "bullish"
        ? `gave back below prior high buffer (${close.toFixed(2)} < ${(prevHigh !== null && triggerZoneBuffer !== null ? prevHigh - triggerZoneBuffer : NaN).toFixed(2)})`
        : `reclaimed above prior low buffer (${close.toFixed(2)} > ${(prevLow !== null && triggerZoneBuffer !== null ? prevLow + triggerZoneBuffer : NaN).toFixed(2)})`,
    );
  }
  if (!triggerZoneRejectionPass) {
    continuationFailureReasons.push(
      direction === "bullish"
        ? `closed in lower half of the bar (closeLocation=${closeLocation.toFixed(2)})`
        : `closed in upper half of the bar (closeLocation=${closeLocation.toFixed(2)})`,
    );
  }

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
  const levelUsed =
    direction === "bullish" && resistanceLevel !== null && Number.isFinite(resistanceLevel)
      ? resistanceLevel
      : direction === "bearish" && supportLevel !== null && Number.isFinite(supportLevel)
        ? supportLevel
        : null;
  const roomPct =
    direction === "bullish" && levelUsed !== null
      ? ((levelUsed - close) / close) * 100
      : direction === "bearish" && levelUsed !== null
        ? ((close - levelUsed) / close) * 100
        : null;
  const higherTimeframeRoomPass = roomPct === null || roomPct >= 0.85;
  const higherTimeframe2RPass = roomPct === null || roomPct >= 2;
  const roomTier: Stage3Diagnostics["roomToTargetDiagnostics"]["roomTier"] =
    roomPct === null
      ? "unknown"
      : roomPct < 0.85
        ? "obvious_no_room"
        : roomPct < 2
          ? "borderline_tight"
          : "workable";
  const roomDecisionMode: Stage3Diagnostics["roomToTargetDiagnostics"]["decisionMode"] = roomPct !== null && roomPct < 0.85 ? "hard_fail" : "score_penalty";
  const roomToTargetDiagnostics: Stage3Diagnostics["roomToTargetDiagnostics"] = {
    referencePrice: close,
    direction,
    levelDetection:
      direction === "bullish"
        ? `bullish uses nearest overhead high from 3M/1Y => min(max3M=${max3M?.toFixed(2) ?? "n/a"}, max1Y=${max1Y?.toFixed(2) ?? "n/a"})`
        : `bearish uses nearest downside low from 3M/1Y => max(min3M=${min3M?.toFixed(2) ?? "n/a"}, min1Y=${min1Y?.toFixed(2) ?? "n/a"})`,
    levelStrength:
      direction === "bullish"
        ? `3M high=${max3M?.toFixed(2) ?? "n/a"}, 1Y high=${max1Y?.toFixed(2) ?? "n/a"}`
        : `3M low=${min3M?.toFixed(2) ?? "n/a"}, 1Y low=${min1Y?.toFixed(2) ?? "n/a"}`,
    levelUsed,
    roomPct,
    targetAssumption: "2R requires roomPct >= 2.00%",
    decisionMode: roomDecisionMode,
    roomTier,
    sufficientRoom: higherTimeframe2RPass,
    insufficientRoomReason:
      roomPct === null
        ? "No finite higher-timeframe level available, treated as pass by current rule."
        : roomTier === "workable"
          ? `Room ${roomPct.toFixed(2)}% meets/exceeds 2.00% threshold.`
          : roomTier === "borderline_tight"
            ? `Room ${roomPct.toFixed(2)}% is below 2.00%, so Prompt 1 should downgrade it as tight overhead room while leaving Prompt 2 to decide whether chart-anchored levels truly support 2R.`
            : `Room ${roomPct.toFixed(2)}% sits inside the immediate 0.85% wall threshold, so Stage 3 treats it as obvious no-room for 2R planning.`,
  };
  const higherTimeframeContextPresent = direction === "bullish" ? max3M !== null && max1Y !== null : min3M !== null && min1Y !== null;

  const triggerZoneFlipCount = (() => {
    const triggerCloses = bars1DForConfirmation.slice(-6).map((bar) => readNumber(bar, ["Close"]));
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
  const messyTriggerZonePass = triggerZoneFlipCount <= 2 || (triggerZoneFlipCount <= 3 && choppyPass);
  const weakContinuationStack = !pullbackBodyControlPass && !pullbackSellingVolumePass;
  if (weakContinuationStack) {
    continuationFailureReasons.push("pullback body and pullback volume both show give-back pressure");
  }
  const severeDistributionStack = !fakeHoldDistributionPass && (!messyTriggerZonePass || !impulseConsolidationPass);
  if (severeDistributionStack) {
    continuationFailureReasons.push("distribution plus weak hold structure is severe");
  }
  const continuationPass =
    decisiveBreakoutContinuationPass ||
    (failedBreakoutBullTrapPass &&
      directionalClosePass &&
      triggerZoneHoldPass &&
      triggerZoneRejectionPass &&
      !weakContinuationStack &&
      !severeDistributionStack);
  const continuationReason = continuationPass
    ? `decisiveBreakout=${decisiveBreakoutContinuationPass ? "yes" : "no"}, triggerHold=${triggerZoneHoldPass ? "ok" : "weak"}, directionalClose=${directionalClosePass ? "ok" : "against"}, rejection=${triggerZoneRejectionPass ? "limited" : "present"}, pullbackBody=${pullbackBodyControlPass ? "controlled" : "heavy"}, pullbackVolume=${pullbackSellingVolumePass ? "controlled" : "expanding"}, distribution=${fakeHoldDistributionPass ? "limited" : "elevated"}, triggerFlips=${messyTriggerZonePass ? "contained" : "messy"}, impulseHold=${impulseConsolidationPass ? "acceptable" : "weak"}`
    : continuationFailureReasons.join("; ");

  const checkDiagnostics: Stage3CheckDiagnostic[] = [
    { check: "alignment", pass: alignmentPass, reason: alignmentReason, impact: getCheckImpactLabel("alignment", volumeRatio) },
    { check: "expansion", pass: expansionPass, reason: `expansionRatio=${expansionRatio === null ? "n/a" : expansionRatio.toFixed(2)}`, impact: getCheckImpactLabel("expansion", volumeRatio) },
    { check: "body-wick", pass: bodyQualityPass, reason: `bodyToRange=${bodyToRange.toFixed(2)}, closeLocation=${closeLocation.toFixed(2)}, wickiness=${wickiness === null ? "n/a" : wickiness.toFixed(2)}`, impact: getCheckImpactLabel("body-wick", volumeRatio) },
    {
      check: "volume",
      pass: volumePass,
      reason:
        volumeRatio === null
          ? `volume ratio unavailable (lastVolume=${lastVolume ?? "n/a"}, priorVolumeBarsWithData=${priorVolumeCount})`
          : `volumeRatio=${volumeRatio.toFixed(2)} using lastVolume=${lastVolume} / avgVolume=${averageVolume?.toFixed(2)}`,
      impact: getCheckImpactLabel("volume", volumeRatio),
    },
    {
      check: "volume-data",
      pass: volumeDataPresent,
      reason: volumeDataPresent ? "volume values parsed from at least one 1D bar" : "missing volume data in 1D bars",
      impact: getCheckImpactLabel("volume-data", volumeRatio),
    },
    { check: "choppy", pass: choppyPass, reason: `flipCount=${flipCount}`, impact: getCheckImpactLabel("choppy", volumeRatio) },
    {
      check: "impulse-consolidation",
      pass: impulseConsolidationPass,
      reason: `impulseMovePct=${impulseMovePct === null ? "n/a" : `${impulseMovePct.toFixed(2)}%`}, impulseAvgRange=${impulseAverageRange?.toFixed(2) ?? "n/a"}, consolidationAvgRange=${consolidationAverageRange?.toFixed(2) ?? "n/a"}`,
      impact: getCheckImpactLabel("impulse-consolidation", volumeRatio),
    },
    {
      check: "fake-hold-distribution",
      pass: fakeHoldDistributionPass,
      reason: `lowerHighCount=${lowerHighCount}, lowerZoneCloseCount=${lowerZoneCloseCount}`,
      impact: getCheckImpactLabel("fake-hold-distribution", volumeRatio),
    },
    {
      check: "failed-breakout-trap",
      pass: failedBreakoutBullTrapPass,
      reason: direction === "bullish" ? `high=${high.toFixed(2)}, close=${close.toFixed(2)}, keyLevel=${keyLevel?.toFixed(2) ?? "n/a"}` : `low=${low.toFixed(2)}, close=${close.toFixed(2)}, keyLevel=${keyLevel?.toFixed(2) ?? "n/a"}`,
      impact: getCheckImpactLabel("failed-breakout-trap", volumeRatio),
    },
    {
      check: "pullback-body-control",
      pass: pullbackBodyControlPass,
      reason: `pullbackAvgBody=${pullbackAverageBody?.toFixed(2) ?? "n/a"}, consolidationAvgBody=${consolidationAverageBody?.toFixed(2) ?? "n/a"}`,
      impact: getCheckImpactLabel("pullback-body-control", volumeRatio),
    },
    {
      check: "pullback-volume-control",
      pass: pullbackSellingVolumePass,
      reason: `pullbackAvgVol=${averagePullbackVolume?.toFixed(0) ?? "n/a"}, nonPullbackAvgVol=${averageNonPullbackVolume?.toFixed(0) ?? "n/a"}, trendUp=${pullbackVolumeTrendUp ? "yes" : "no"}`,
      impact: getCheckImpactLabel("pullback-volume-control", volumeRatio),
    },
    {
      check: "trigger-zone-flips",
      pass: messyTriggerZonePass,
      reason: `triggerZoneFlipCount=${triggerZoneFlipCount}`,
      impact: getCheckImpactLabel("trigger-zone-flips", volumeRatio),
    },
    { check: "continuation", pass: continuationPass, reason: continuationReason, impact: getCheckImpactLabel("continuation", volumeRatio) },
    {
      check: "higher-timeframe-context",
      pass: higherTimeframeContextPresent,
      reason: higherTimeframeContextPresent ? "3M/1Y highs/lows available" : "missing higher-timeframe context (3M/1Y high/low data)",
      impact: getCheckImpactLabel("higher-timeframe-context", volumeRatio),
    },
    { check: "higher-timeframe-room", pass: higherTimeframeRoomPass, reason: `roomPct=${roomPct === null ? "n/a" : roomPct.toFixed(2)}%; ${describeRoomToTargetDecision(roomToTargetDiagnostics)}`, impact: getCheckImpactLabel("higher-timeframe-room", volumeRatio) },
    { check: "higher-timeframe-2r-viability", pass: higherTimeframe2RPass, reason: `${describeRoomToTargetDecision(roomToTargetDiagnostics)}`, impact: getCheckImpactLabel("higher-timeframe-2r-viability", volumeRatio) },
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
  const pass = passedChecks >= 8 && continuationPass;

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
    `trigger-zone-flips ${messyTriggerZonePass ? "low" : "elevated"}`,
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
      roomToTargetDiagnostics,
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

export function parseBars(payload: unknown): Record<string, unknown>[] {
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

export function normalizeBar(bar: Record<string, unknown>): Record<string, unknown> {
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

async function evaluateStage2Strike(
  get: (path: string) => Promise<Response>,
  symbol: string,
  expirationDate: string,
  strike: OptionStrikeCandidate,
): Promise<Stage2ContractEvaluation> {
  const symbolsToTry = buildDirectOptionSymbols(symbol, expirationDate, strike);
  const { quote, attempts } = await fetchFirstUsableDirectOptionQuote(get, symbolsToTry);

  if (!quote) {
    return {
      strike,
      quote: null,
      attempts,
      reason: "No usable direct option quote found for strike.",
      spreadPercent: null,
    };
  }

  const spreadPercent = quote.mid > 0 ? quote.spread / quote.mid : Number.POSITIVE_INFINITY;
  if (quote.openInterest <= 500) {
    return {
      strike,
      quote,
      attempts,
      reason: "Candidate contract failed OI threshold (requires > 500).",
      spreadPercent,
    };
  }

  if (quote.spread > 1.5 || spreadPercent > 0.12) {
    return {
      strike,
      quote,
      attempts,
      reason: "Candidate contract failed spread threshold (requires <= 1.5 and <= 12% of mid).",
      spreadPercent,
    };
  }

  return {
    strike,
    quote,
    attempts,
    reason: "Passed Stage 2 filters.",
    spreadPercent,
  };
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

    const nearbyStrikes = [...strikes]
      .sort((a, b) => Math.abs(a.strike - underlyingPriceForStrikeSelection) - Math.abs(b.strike - underlyingPriceForStrikeSelection))
      .slice(0, 3);
    const selectedStrike = nearbyStrikes[0];

    if (!selectedStrike) {
      diagnostic.reason = "Unable to select strike near underlying price.";
      diagnostics.push(diagnostic);
      continue;
    }

    let passingEvaluation: Stage2ContractEvaluation | null = null;
    let fallbackEvaluation: Stage2ContractEvaluation | null = null;

    for (const strikeCandidate of nearbyStrikes) {
      const evaluation = await evaluateStage2Strike(get, candidate.symbol, targetExpiration.date, strikeCandidate);
      diagnostic.optionQuoteAttempts.push(...evaluation.attempts);

      if (fallbackEvaluation === null) {
        fallbackEvaluation = evaluation;
      }

      if (evaluation.quote) {
        fallbackEvaluation = evaluation;
      }

      if (evaluation.reason === "Passed Stage 2 filters.") {
        passingEvaluation = evaluation;
        break;
      }
    }

    const finalEvaluation = passingEvaluation ?? fallbackEvaluation;
    diagnostic.selectedStrike = finalEvaluation?.strike.strike ?? selectedStrike.strike;

    if (!finalEvaluation || !finalEvaluation.quote) {
      diagnostic.reason = "No usable direct option quote found for selected or nearby strikes.";
      diagnostics.push(diagnostic);
      continue;
    }

    diagnostic.evaluatedContract = finalEvaluation.quote.optionSymbol;
    diagnostic.bid = finalEvaluation.quote.bid;
    diagnostic.ask = finalEvaluation.quote.ask;
    diagnostic.spreadWidth = finalEvaluation.quote.spread;
    diagnostic.spreadPercent = finalEvaluation.spreadPercent;
    diagnostic.openInterest = finalEvaluation.quote.openInterest;
    diagnostic.reason = finalEvaluation.reason;

    if (finalEvaluation.reason !== "Passed Stage 2 filters.") {
      diagnostics.push(diagnostic);
      continue;
    }

    diagnostic.pass = true;

    stage2Passed.push({
      ...candidate,
      targetExpiration: targetExpiration.date,
      targetDte: targetExpiration.dte,
      optionOpenInterest: finalEvaluation.quote.openInterest,
      optionSpread: finalEvaluation.quote.spread,
      optionMid: finalEvaluation.quote.mid,
    });
    diagnostics.push(diagnostic);
  }

  return { passed: stage2Passed, diagnostics };
}

type TierScanExecution = {
  tier: ScanUniverseTier;
  result: ScanResult;
  telemetry: StarterUniverseTelemetry;
};

function buildTierSummary(
  tier: ScanUniverseTier,
  telemetry: StarterUniverseTelemetry,
  result: ScanResult,
): TierSummary {
  return {
    tier: tier.key,
    label: tier.label,
    description: tier.description,
    counts: telemetry.stageCounts,
    symbols: telemetry.stageSymbols,
    finalistsReviewed: telemetry.stageSymbols.finalistsReviewed,
    concludedWith: result.conclusion,
    winner: result.ticker,
    noTradeReason: result.conclusion === "confirmed" ? null : result.reason,
  };
}

function mergeRejectionSummaries(...summaries: StarterUniverseTelemetry["rejectionSummaries"][]): StarterUniverseTelemetry["rejectionSummaries"] {
  const merged: StarterUniverseTelemetry["rejectionSummaries"] = {
    stage1: {},
    stage2: {},
    stage3: {},
  };

  for (const summary of summaries) {
    for (const stageKey of ["stage1", "stage2", "stage3"] as const) {
      for (const [reason, count] of Object.entries(summary[stageKey])) {
        merged[stageKey][reason] = (merged[stageKey][reason] ?? 0) + count;
      }
    }
  }

  return merged;
}

function combineTelemetry(
  executions: TierScanExecution[],
  selectedSymbol: string | null,
  winningTier: ScanUniverseTierKey | null,
  finalNoTradeExplanation: string | null,
): StarterUniverseTelemetry {
  const scannedTiers = executions.map((item) => item.tier.key);
  const tierSummaries = executions.map((item) => buildTierSummary(item.tier, item.telemetry, item.result));
  const stageCounts = executions.reduce<StarterUniverseStageCounts>(
    (acc, item) => ({
      stage1Entered: acc.stage1Entered + item.telemetry.stageCounts.stage1Entered,
      stage1Passed: acc.stage1Passed + item.telemetry.stageCounts.stage1Passed,
      stage2Passed: acc.stage2Passed + item.telemetry.stageCounts.stage2Passed,
      stage3Passed: acc.stage3Passed + item.telemetry.stageCounts.stage3Passed,
      continuationEligibleFinalists: acc.continuationEligibleFinalists + item.telemetry.stageCounts.continuationEligibleFinalists,
      confirmationEligibleFinalists: acc.confirmationEligibleFinalists + item.telemetry.stageCounts.confirmationEligibleFinalists,
      finalistsReviewed: acc.finalistsReviewed + item.telemetry.stageCounts.finalistsReviewed,
      finalRanking: acc.finalRanking + item.telemetry.stageCounts.finalRanking,
    }),
    {
      stage1Entered: 0,
      stage1Passed: 0,
      stage2Passed: 0,
      stage3Passed: 0,
      continuationEligibleFinalists: 0,
      confirmationEligibleFinalists: 0,
      finalistsReviewed: 0,
      finalRanking: 0,
    },
  );
  const stageSymbols = executions.reduce<StarterUniverseStageSymbols>(
    (acc, item) => ({
      stage1Entered: [...acc.stage1Entered, ...item.telemetry.stageSymbols.stage1Entered],
      stage1Passed: [...acc.stage1Passed, ...item.telemetry.stageSymbols.stage1Passed],
      stage2Passed: [...acc.stage2Passed, ...item.telemetry.stageSymbols.stage2Passed],
      stage3Passed: [...acc.stage3Passed, ...item.telemetry.stageSymbols.stage3Passed],
      continuationEligibleFinalists: [...acc.continuationEligibleFinalists, ...item.telemetry.stageSymbols.continuationEligibleFinalists],
      confirmationEligibleFinalists: [...acc.confirmationEligibleFinalists, ...item.telemetry.stageSymbols.confirmationEligibleFinalists],
      finalistsReviewed: [...acc.finalistsReviewed, ...item.telemetry.stageSymbols.finalistsReviewed],
      finalRanking: [...acc.finalRanking, ...item.telemetry.stageSymbols.finalRanking],
    }),
    {
      stage1Entered: [],
      stage1Passed: [],
      stage2Passed: [],
      stage3Passed: [],
      continuationEligibleFinalists: [],
      confirmationEligibleFinalists: [],
      finalistsReviewed: [],
      finalRanking: [],
    },
  );
  const finalTelemetry = executions.at(-1)?.telemetry;
  const reviewedFinalistOutcomes = executions.flatMap((item) => item.telemetry.reviewedFinalistOutcomes);

  return {
    stageCounts,
    stageSymbols,
    finalistsReviewedDebug: executions.flatMap((item) => item.telemetry.finalistsReviewedDebug),
    stage3PassedDetails: executions.flatMap((item) => item.telemetry.stage3PassedDetails),
    finalRankingDebug: executions.flatMap((item) => item.telemetry.finalRankingDebug),
    rejectionSummaries: mergeRejectionSummaries(...executions.map((item) => item.telemetry.rejectionSummaries)),
    nearMisses: executions.flatMap((item) => item.telemetry.nearMisses),
    consistencyChecks: executions.flatMap((item) => item.telemetry.consistencyChecks),
    finalSelectedSymbol: selectedSymbol,
    topRankedSymbol: finalTelemetry?.topRankedSymbol ?? null,
    scannedTiers,
    winningTier,
    tierSummaries,
    tierStageCounts: Object.fromEntries(tierSummaries.map((summary) => [summary.tier, summary.counts])),
    tierFinalistsReviewed: Object.fromEntries(tierSummaries.map((summary) => [summary.tier, summary.finalistsReviewed])),
    cumulativeStageCounts: stageCounts,
    finalNoTradeExplanation,
    reviewedFinalistOutcomes,
    bestReviewedFinalistsAcrossTiers: finalTelemetry?.bestReviewedFinalistsAcrossTiers ?? reviewedFinalistOutcomes.map((item) => item.symbol),
    bestRejectedCandidates: finalTelemetry?.bestRejectedCandidates ?? reviewedFinalistOutcomes.map((item) => ({
      symbol: item.symbol,
      tier: item.tier,
      tierLabel: item.tierLabel,
      rejectionReasons: item.confirmationFailureReasons,
    })),
    crossTierFinalistSummary: finalTelemetry?.crossTierFinalistSummary ?? null,
  };
}

async function runUniverseTierTradeStationScan(
  get: Awaited<ReturnType<typeof createTradeStationGetFetcher>>,
  input: ScanInput,
  tier: ScanUniverseTier,
): Promise<ScanResult> {
  const excludedSet = new Set((input.excludedTickers ?? []).map((item) => item.toUpperCase()));
  const stage1Entered = tier.symbols.filter((symbol) => !excludedSet.has(symbol));
  const stage1RejectionSummary: StageFailureSummary = {};
  const stage2RejectionSummary: StageFailureSummary = {};
  const stage3RejectionSummary: StageFailureSummary = {};
  logGeneralScanDebug(`${tier.label} Stage 1 entered`, stage1Entered);

  const stage1Passed: Stage1Candidate[] = [];
  for (const symbol of tier.symbols) {
    if (excludedSet.has(symbol)) {
      continue;
    }

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
  const stage1BySymbol = new Map(stage1Passed.map((candidate) => [candidate.symbol, candidate]));

  const buildScanTelemetry = (params: {
    stage2Passed?: OptionsCandidate[];
    stage3Evaluations?: Stage3Evaluation[];
    ranked?: (ChartCandidate & { score: number })[];
    finalRankingDebug?: FinalRankingEntry[];
    finalistReviewSource?: FinalistReviewSource;
    finalistReviewResults?: FinalistReviewResult[];
    selectedSymbol?: string | null;
    finalNoTradeExplanation?: string | null;
  }): StarterUniverseTelemetry => {
    const stage2Passed = params.stage2Passed ?? [];
    const stage3Evaluations = params.stage3Evaluations ?? [];
    const ranked = params.ranked ?? [];
    const finalRankingDebug = params.finalRankingDebug ?? [];
    const finalistReviewSource = params.finalistReviewSource ?? buildFinalistReviewSource([], [], []);
    const finalistReviewResults = params.finalistReviewResults ?? [];

    return buildStarterUniverseTelemetry({
      stage1Entered,
      stage1Passed,
      stage2Passed,
      stage3Evaluations,
      ranked,
      finalRankingDebug,
      finalistReviewSource,
      finalistReviewResults,
      rejectionSummaries: {
        stage1: stage1RejectionSummary,
        stage2: stage2RejectionSummary,
        stage3: stage3RejectionSummary,
      },
      selectedSymbol: params.selectedSymbol ?? null,
      scannedTiers: [tier.key],
      winningTier: params.selectedSymbol ? tier.key : null,
      finalNoTradeExplanation: params.finalNoTradeExplanation ?? null,
      tierSummaries: [],
    });
  };

  logGeneralScanDebug(`${tier.label} Stage 1 passed`, stage1Passed.map((candidate) => candidate.symbol));

  if (stage1Passed.length === 0) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: `No symbols passed Stage 1 stock filters in ${tier.label}.`,
      telemetry: buildScanTelemetry({ finalNoTradeExplanation: `No symbols passed Stage 1 stock filters in ${tier.label}.` }),
    };
  }

  const { passed: stage2Passed, diagnostics: stage2Diagnostics } = await runStage2OptionsTradability(get, stage1Passed);
  const stage2BySymbol = new Map(stage2Passed.map((candidate) => [candidate.symbol, candidate]));
  for (const item of stage2Diagnostics) {
    if (!item.pass) {
      incrementSummary(stage2RejectionSummary, categorizeStage2Failure(item.reason));
    }
  }
  logStage2Diagnostics(stage2Diagnostics);
  logGeneralScanDebug(`${tier.label} Stage 2 passed`, stage2Passed.map((candidate) => candidate.symbol));

  if (stage2Passed.length === 0) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: `No symbols passed Stage 2 options tradability filters in ${tier.label}.`,
      telemetry: buildScanTelemetry({ stage2Passed, finalNoTradeExplanation: `No symbols passed Stage 2 options tradability filters in ${tier.label}.` }),
    };
  }

  const stage3Evaluations = await evaluateStage3Candidates(get, stage2Passed);
  const stage3Passed = stage3Evaluations.flatMap((item) => (item.candidate ? [item.candidate] : []));
  for (const evaluation of stage3Evaluations) {
    if (!evaluation.pass && evaluation.rejectionReason) {
      incrementSummary(stage3RejectionSummary, evaluation.rejectionReason);
    }
  }
  const stage3BySymbol = new Map(stage3Passed.map((candidate) => [candidate.symbol, candidate]));
  logGeneralScanDebug(`${tier.label} Stage 3 passed`, stage3Passed.map((candidate) => candidate.symbol));

  if (stage3Passed.length === 0) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: `No symbols passed Stage 3 chart/bar review in ${tier.label}.`,
      telemetry: buildScanTelemetry({ stage2Passed, stage3Evaluations, finalNoTradeExplanation: `No symbols passed Stage 3 chart/bar review in ${tier.label}.` }),
    };
  }

  const { ranked, debug: finalRankingDebug } = buildFinalRanking(stage3Passed);
  logStage3PassThroughDebugSection(stage3Evaluations, finalRankingDebug, ranked[0]?.score ?? null);
  logFinalRankingDebugSection(finalRankingDebug);

  const finalistReviewSource = buildFinalistReviewSource(
    ranked,
    stage2Passed.map((candidate) => candidate.symbol),
    stage3Passed.map((candidate) => candidate.symbol),
  );
  const finalists = finalistReviewSource.finalists;
  logGeneralScanDebug(`${tier.label} continuation-eligible finalists`, finalistReviewSource.continuationEligibleFinalists.map((candidate) => candidate.symbol));
  logGeneralScanDebug(`${tier.label} confirmation-eligible finalists`, finalistReviewSource.confirmationEligibleFinalists.map((candidate) => candidate.symbol));
  for (const warning of finalistReviewSource.warnings) {
    console.warn(`[scanner:debug] ${warning}`);
  }

  if (finalists.length === 0) {
    const reason = `No continuation-pass Stage 3 finalists with higher-timeframe 2R viability remained for immediate-entry confirmation review in ${tier.label}.`;
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason,
      telemetry: buildScanTelemetry({ stage2Passed, stage3Evaluations, ranked, finalRankingDebug, finalistReviewSource, finalNoTradeExplanation: reason }),
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
          direction: null,
          confidence: null,
          reviewStatus: "reviewed",
          confirmationStatus: "rejected",
          confirmationFailureReasons: ["earnings risk inside target DTE window"],
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
                  roomToTargetDecision: describeRoomToTargetDecision(item.chartDiagnostics.roomToTargetDiagnostics),
                }
              : null;
          })(),
          conclusion: "rejected",
          reason: `Rejected by earnings-inside-DTE exclusion. ${earningsCheck.reason}`,
        });
        continue;
      }
    }

    const reviewResult: SingleSymbolReviewResult = await runSingleSymbolTradeStationAnalysis(finalist.symbol);
    finalistReviewResults.push({
      symbol: finalist.symbol,
      direction: reviewResult.direction,
      confidence: reviewResult.confidence,
      reviewStatus: reviewResult.confirmationDebug?.reviewStatus ?? "reviewed",
      confirmationStatus: reviewResult.conclusion === "confirmed" ? "confirmed" : "rejected",
      confirmationFailureReasons: reviewResult.confirmationDebug?.confirmationFailureReasons ?? ["final confirmation checks did not pass"],
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
              roomToTargetDecision: describeRoomToTargetDecision(item.chartDiagnostics.roomToTargetDiagnostics),
            }
          : null;
      })(),
      conclusion: reviewResult.conclusion,
      reason: reviewResult.reason,
    });

    if (reviewResult.conclusion === "confirmed" && reviewResult.ticker && reviewResult.direction && reviewResult.confidence) {
      logGeneralScanDebug(`${tier.label} final selected`, [reviewResult.ticker]);
      logFinalistReviewDebugSection(finalistReviewResults, reviewResult.ticker);
      const telemetry = buildScanTelemetry({
        stage2Passed,
        stage3Evaluations,
        ranked,
        finalRankingDebug,
        finalistReviewSource,
        finalistReviewResults,
        selectedSymbol: reviewResult.ticker,
      });

      return {
        ticker: reviewResult.ticker,
        direction: reviewResult.direction,
        confidence: reviewResult.confidence,
        conclusion: "confirmed",
        reason: `Finalist confirmation passed after Stage 1/2/3 scoring (reviewed: ${finalistReviewResults.map((item) => item.symbol).join(", ")}; selected: ${reviewResult.ticker}; rank score ${finalist.score.toFixed(2)}). ${getSelectionWhyWonReason(finalistReviewResults, reviewResult.ticker)} ${reviewResult.reason}`,
        telemetry,
      };
    }
  }

  logFinalistReviewDebugSection(finalistReviewResults, null);
  const noTradeReason = buildConsistentNoTradeReason(
    finalistReviewResults,
    stage3Passed.map((candidate) => candidate.symbol),
    ranked.map((candidate) => candidate.symbol),
  );
  for (const warning of noTradeReason.symbolConsistencyWarnings) {
    console.warn(`[scanner:debug] ${warning}`);
  }
  const telemetry = buildScanTelemetry({
    stage2Passed,
    stage3Evaluations,
    ranked,
    finalRankingDebug,
    finalistReviewSource,
    finalistReviewResults,
    selectedSymbol: null,
    finalNoTradeExplanation: noTradeReason.reason,
  });

  return {
    ticker: null,
    direction: null,
    confidence: null,
    conclusion: "no_trade_today",
    reason: noTradeReason.reason,
    telemetry,
  };
}

async function runStarterUniverseTradeStationScan(input: ScanInput): Promise<ScanResult> {
  const get = await createTradeStationGetFetcher();
  const tierExecutions: TierScanExecution[] = [];

  for (const tier of SCAN_UNIVERSE_TIERS) {
    const result = await runUniverseTierTradeStationScan(get, input, tier);
    const telemetry = result.telemetry;
    if (!telemetry) {
      continue;
    }

    tierExecutions.push({ tier, result, telemetry });
    if (result.conclusion === "confirmed" && result.ticker && result.direction && result.confidence) {
      const combinedTelemetry = combineTelemetry(tierExecutions, result.ticker, tier.key, null);
      return {
        ...result,
        telemetry: combinedTelemetry,
      };
    }
  }

  const crossTierNoTradeSummary = buildCrossTierNoTradeSummary(tierExecutions);
  const combinedTelemetry = combineTelemetry(tierExecutions, null, null, crossTierNoTradeSummary.finalNoTradeExplanation);
  combinedTelemetry.reviewedFinalistOutcomes = crossTierNoTradeSummary.reviewedFinalistOutcomes;
  combinedTelemetry.bestReviewedFinalistsAcrossTiers = crossTierNoTradeSummary.bestReviewedFinalistsAcrossTiers;
  combinedTelemetry.bestRejectedCandidates = crossTierNoTradeSummary.bestRejectedCandidates;
  combinedTelemetry.crossTierFinalistSummary = crossTierNoTradeSummary.crossTierFinalistSummary;

  return {
    ticker: null,
    direction: null,
    confidence: null,
    conclusion: "no_trade_today",
    reason: crossTierNoTradeSummary.finalNoTradeExplanation,
    telemetry: combinedTelemetry,
  };
}

export async function runStage2DebugForStarterUniverse(): Promise<Stage2SymbolDiagnostic[]> {
  const get = await createTradeStationGetFetcher();
  const stage1Candidates: Stage1Candidate[] = CORE_SCAN_UNIVERSE.map((symbol) => ({
    symbol,
    lastPrice: 1,
    averageVolume: null,
  }));
  const { diagnostics } = await runStage2OptionsTradability(get, stage1Candidates);
  return diagnostics;
}

export async function runStarterUniverseTelemetryDebug(): Promise<StarterUniverseTelemetry> {
  const get = await createTradeStationGetFetcher();
  const tier = SCAN_UNIVERSE_TIERS[0];
  if (!tier) {
    throw new Error("Tier 1 universe is not configured.");
  }

  const result = await runUniverseTierTradeStationScan(get, { prompt: "debug starter universe", excludedTickers: [] }, tier);
  if (!result.telemetry) {
    throw new Error("Tier 1 telemetry was unavailable.");
  }

  return result.telemetry;
}

export async function runStage3DebugForStarterUniverse(): Promise<
  { symbol: string; pass: boolean; direction: ScanDirection | null; movePct: number; volumeRatio: number | null; score: number; summary: string; diagnostics: Stage3Diagnostics }[]
> {
  const get = await createTradeStationGetFetcher();
  const results: { symbol: string; pass: boolean; direction: ScanDirection | null; movePct: number; volumeRatio: number | null; score: number; summary: string; diagnostics: Stage3Diagnostics }[] = [];

  for (const symbol of CORE_SCAN_UNIVERSE) {
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
          roomToTargetDiagnostics: {
            referencePrice: 0,
            direction: "bullish",
            levelDetection: "n/a",
            levelStrength: "n/a",
            levelUsed: null,
            roomPct: null,
            targetAssumption: "2R requires roomPct >= 2.00%",
            decisionMode: "score_penalty",
            roomTier: "unknown",
            sufficientRoom: true,
            insufficientRoomReason: "No data because bars failed to load.",
          },
          checks: [{ check: "bars-load", pass: false, reason: "failed to load required multi-timeframe bars", impact: "blocker" }],
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

export async function runSingleSymbolTradeStationAnalysis(symbol: string): Promise<SingleSymbolReviewResult> {
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
        confirmationDebug: buildConfirmationDebug(null, "rejected", ["earnings risk inside target DTE window"], {
          topBlockingReasons: ["earnings risk inside target DTE window"],
        }),
      };
    }
  }

  const { barsByView: bars, timeframeDiagnostics } = await loadMultiTimeframeBars(get, symbol);
  if (bars) {
    const review = runStage3ChartReview(bars, timeframeDiagnostics);
    const outcome = resolveConfirmationOutcome(review);
    let chartAnchoredFailureReason: string | null = null;

    if (outcome.conclusion === "confirmed" && review.direction) {
      const chartAnchoredResult = await evaluateChartAnchoredTradability(
        get,
        symbol,
        review.direction,
        review.diagnostics.roomToTargetDiagnostics.referencePrice,
      );
      if (!chartAnchoredResult.pass) {
        chartAnchoredFailureReason = chartAnchoredResult.reason;
        outcome.conclusion = "rejected";
        outcome.confidence = null;
      }
    }

    const reviewNarrative = buildSingleSymbolReviewNarrative(review, outcome.conclusion, chartAnchoredFailureReason);

    if (outcome.conclusion === "confirmed" && review.direction && outcome.confidence) {
      return {
        ticker: symbol,
        direction: review.direction,
        confidence: outcome.confidence,
        conclusion: "confirmed",
        reason: reviewNarrative,
        confirmationDebug: buildConfirmationDebug(review, "confirmed", []),
      };
    }

    return {
      ticker: symbol,
      direction: review.direction,
      confidence: null,
      conclusion: "rejected",
      reason: reviewNarrative,
      confirmationDebug: buildConfirmationDebug(
        review,
        "rejected",
        chartAnchoredFailureReason
          ? [...getConfirmationRejectionReasons(review), chartAnchoredFailureReason]
          : getConfirmationRejectionReasons(review),
        chartAnchoredFailureReason
          ? {
              topBlockingReasons: [...getConfirmationStructureDebug(review).topBlockingReasons, chartAnchoredFailureReason],
            }
          : undefined,
      ),
    };
  }

  return {
    ticker: symbol,
    direction: null,
    confidence: null,
    conclusion: "no_trade_today",
    reason: "Could not review the full 1D/1W/1M/3M/1Y chart context from TradeStation data, so no_trade_today.",
    confirmationDebug: buildConfirmationDebug(null, "rejected", ["missing multi-timeframe chart context"], {
      topBlockingReasons: ["missing multi-timeframe chart context"],
    }),
  };
}

function buildSingleSymbolReviewNarrative(
  review: ChartReviewResult,
  conclusion: ScanResult["conclusion"],
  chartAnchoredFailureReason: string | null = null,
): string {
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

  if (checkByName.get("expansion")?.pass) {
    supportive.push("range expansion is acceptable relative to recent bars");
  } else {
    problematic.push(`range expansion is weaker than ideal (${checkByName.get("expansion")?.reason ?? "expansion ratio unavailable"})`);
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

  const roomDecision = describeRoomToTargetDecision(review.diagnostics.roomToTargetDiagnostics);
  if (checkByName.get("higher-timeframe-room")?.pass) {
    supportive.push(`higher-timeframe room/resistance appears workable (${roomPct === null ? "room n/a" : `${roomPct.toFixed(2)}% room`}; ${roomDecision})`);
  } else {
    problematic.push(`higher-timeframe room/resistance looks tight (${roomPct === null ? "room n/a" : `${roomPct.toFixed(2)}% room`}; ${roomDecision})`);
  }

  const structureDebug = getConfirmationStructureDebug(review);
  const structureInPrinciple = structureDebug.supportsTradable2RStructure && !chartAnchoredFailureReason;
  if (structureInPrinciple) {
    supportive.push("the chart supports a tradable clean 2:1-style structure (continuation + room + 2R viability)");
  } else if (chartAnchoredFailureReason) {
    problematic.push(`tradable clean 2:1 structure failed chart-anchored invalidation/target test (${chartAnchoredFailureReason})`);
  } else if (structureDebug.topBlockingReasons.length === 1) {
    problematic.push(`tradable clean 2:1 structure is not clear yet (${structureDebug.topBlockingReasons[0]})`);
  } else {
    problematic.push(`tradable clean 2:1 structure is not clear yet (${formatFinalistReasonList(structureDebug.topBlockingReasons)})`);
  }

  if (conclusion === "confirmed" && problematic.length > 0) {
    const reframedProblematic = problematic.map((item) => `caution: ${item}`);
    problematic.length = 0;
    problematic.push(...reframedProblematic);
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
        reason: `General scan mode is limited to the configured scan universes.`,
        telemetry: null,
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
      telemetry: null,
    };
  }

  return runSingleSymbolTradeStationAnalysis(symbolMatch.symbol);
}
