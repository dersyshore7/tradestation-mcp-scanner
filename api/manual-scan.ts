import {
  mergeFinalizedAsymmetryIntoFinalistsReviewedDebug,
  runScan,
  type ScanResult,
  type StarterUniverseTelemetry,
} from "../src/app/runScan.js";
import { buildWorkflowPresentationSummary } from "../src/app/resultPresentation.js";
import {
  constructTradeCard,
  type TradeConstructionResult,
} from "../src/app/runTradeConstruction.js";
import { DEFAULT_SCAN_PROMPT } from "../src/config/defaultScanPrompt.js";
import {
  SCAN_UNIVERSE_TIERS,
  type ScanUniverseTierKey,
} from "../src/config/scanUniverseTiers.js";
import { createTradeRecommendation } from "../src/recommendations/repository.js";

type VercelRequestLike = {
  method?: string;
  body?: unknown;
};

type VercelResponseLike = {
  status: (code: number) => VercelResponseLike;
  json: (body: unknown) => void;
  setHeader?: (name: string, value: string) => void;
};

type ManualScanRequestBody = {
  prompt?: string;
  state?: unknown;
};

type ManualScanChunkSummary = {
  tier: string;
  label: string;
  from: number;
  to: number;
  symbols: string[];
  conclusion: ScanResult["conclusion"] | "blocked_after_confirmation";
  selectedSymbol: string | null;
  rankingScore: number | null;
  tradeCardReady: boolean;
  reason: string;
  durationMs: number;
};

type ManualScanBest = {
  score: number;
  scan: ScanResult;
  telemetry: StarterUniverseTelemetry | null;
  tradeCard: TradeConstructionResult;
  chunkSummary: ManualScanChunkSummary;
};

type ManualScanState = {
  version: 2;
  scanRunId: string;
  prompt: string;
  status: "running" | "completed";
  tierIndex: number;
  tierCursor: number;
  chunkCount: number;
  scannedSymbolCount: number;
  startedAt: string;
  bestConfirmed: ManualScanBest | null;
  chunkSummaries: ManualScanChunkSummary[];
  accumulatedTelemetry: StarterUniverseTelemetry | null;
  latestDataHealth: StarterUniverseTelemetry["dataHealth"] | null;
  resumeAfter: string | null;
  quotaPauseCount: number;
  lastQuotaReason: string | null;
  finalResponse: ManualScanCompletedPayload | null;
};

type ManualScanCompletedPayload = {
  scan_run_id: string;
  prompt: string;
  status: "completed";
  progress: ManualScanProgress;
  scan: ScanResult;
  tradeCard: TradeConstructionResult | null;
  journalPlannedTrade?: TradeConstructionResult["plannedJournalFields"];
  tradeRecommendation: unknown;
  telemetry: StarterUniverseTelemetry | null;
  presentationSummary: ReturnType<typeof buildWorkflowPresentationSummary>;
  manualScan: {
    chunkCount: number;
    scannedSymbolCount: number;
    totalSymbolCount: number;
    bestSymbol: string | null;
    chunkSummaries: ManualScanChunkSummary[];
  };
};

type ManualScanProgress = {
  text: string;
  tier: string | null;
  scannedSymbolCount: number;
  totalSymbolCount: number;
  chunkCount: number;
  bestSymbol: string | null;
  nextPollDelayMs?: number;
};

const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_MANUAL_SCAN_MAX_QUOTA_PAUSES = 3;
const STAGE_COUNT_KEYS = [
  "stage1Entered",
  "stage1Passed",
  "stage2Passed",
  "stage3Passed",
  "continuationEligibleFinalists",
  "confirmationEligibleFinalists",
  "finalistsReviewed",
  "finalRanking",
] as const;
const STAGE_SYMBOL_KEYS = [...STAGE_COUNT_KEYS] as const;

type StageCounts = StarterUniverseTelemetry["stageCounts"];
type StageSymbols = StarterUniverseTelemetry["stageSymbols"];
type RejectionSummaries = StarterUniverseTelemetry["rejectionSummaries"];
type TierSummary = StarterUniverseTelemetry["tierSummaries"][number];

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildScanRunId(): string {
  return `manual_scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toSerializableJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sendJson(res: VercelResponseLike, statusCode: number, body: unknown): void {
  res.setHeader?.("content-type", "application/json; charset=utf-8");
  res.status(statusCode).json(toSerializableJsonValue(body));
}

function readPrompt(body: unknown): string {
  const payload = (body ?? {}) as ManualScanRequestBody;
  return typeof payload.prompt === "string" && payload.prompt.trim().length > 0
    ? payload.prompt.trim()
    : DEFAULT_SCAN_PROMPT;
}

function readChunkSize(): number {
  const parsed = Number(process.env.MANUAL_SCAN_CHUNK_SIZE ?? DEFAULT_CHUNK_SIZE);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CHUNK_SIZE;
  }
  return Math.max(3, Math.min(20, Math.floor(parsed)));
}

function readManualScanMaxQuotaPauses(): number {
  const parsed = Number(process.env.MANUAL_SCAN_MAX_QUOTA_PAUSES ?? DEFAULT_MANUAL_SCAN_MAX_QUOTA_PAUSES);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MANUAL_SCAN_MAX_QUOTA_PAUSES;
  }
  return Math.max(0, Math.min(10, Math.floor(parsed)));
}

function readQuotaBackoffMs(): number {
  const parsed = Number(process.env.TRADESTATION_QUOTA_BACKOFF_MS ?? 15_000);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 15_000;
  }
  return parsed;
}

function totalSymbolCount(): number {
  return SCAN_UNIVERSE_TIERS.reduce((total, tier) => total + tier.symbols.length, 0);
}

function scanUniverseLabel(): string {
  return `${totalSymbolCount()} symbols across ${SCAN_UNIVERSE_TIERS.map((tier) => tier.label).join(", ")}`;
}

function countSymbolsBeforeTier(tierIndex: number): number {
  return SCAN_UNIVERSE_TIERS
    .slice(0, tierIndex)
    .reduce((total, tier) => total + tier.symbols.length, 0);
}

function buildEmptyStageCounts(): StageCounts {
  return {
    stage1Entered: 0,
    stage1Passed: 0,
    stage2Passed: 0,
    stage3Passed: 0,
    continuationEligibleFinalists: 0,
    confirmationEligibleFinalists: 0,
    finalistsReviewed: 0,
    finalRanking: 0,
  };
}

function buildEmptyStageSymbols(): StageSymbols {
  return {
    stage1Entered: [],
    stage1Passed: [],
    stage2Passed: [],
    stage3Passed: [],
    continuationEligibleFinalists: [],
    confirmationEligibleFinalists: [],
    finalistsReviewed: [],
    finalRanking: [],
  };
}

function mergeStageCounts(left: StageCounts, right: StageCounts): StageCounts {
  return STAGE_COUNT_KEYS.reduce((merged, key) => {
    merged[key] = left[key] + right[key];
    return merged;
  }, buildEmptyStageCounts());
}

function mergeStageSymbols(left: StageSymbols, right: StageSymbols): StageSymbols {
  return STAGE_SYMBOL_KEYS.reduce((merged, key) => {
    merged[key] = [...left[key], ...right[key]];
    return merged;
  }, buildEmptyStageSymbols());
}

function mergeFailureSummaries(
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> {
  const merged = { ...left };
  for (const [reason, count] of Object.entries(right)) {
    merged[reason] = (merged[reason] ?? 0) + count;
  }
  return merged;
}

function mergeRejectionSummaries(
  left: RejectionSummaries,
  right: RejectionSummaries,
): RejectionSummaries {
  return {
    stage1: mergeFailureSummaries(left.stage1, right.stage1),
    stage2: mergeFailureSummaries(left.stage2, right.stage2),
    stage3: mergeFailureSummaries(left.stage3, right.stage3),
  };
}

function buildEmptyRejectionSummaries(): RejectionSummaries {
  return {
    stage1: {},
    stage2: {},
    stage3: {},
  };
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function buildMergedDataHealth(params: {
  stageCounts: StageCounts;
  stage1QuoteAttempts: number;
  stage1QuoteFailures: number;
  symbolsRecoveredByFallback: number;
  stage2RequestFailures: StarterUniverseTelemetry["dataHealth"]["stage2RequestFailures"];
  stage3BarLoadFailures: StarterUniverseTelemetry["dataHealth"]["stage3BarLoadFailures"];
}): StarterUniverseTelemetry["dataHealth"] {
  const {
    stageCounts,
    stage1QuoteAttempts,
    stage1QuoteFailures,
    symbolsRecoveredByFallback,
    stage2RequestFailures,
    stage3BarLoadFailures,
  } = params;
  const stage1QuoteFailureRate =
    stage1QuoteAttempts > 0 ? stage1QuoteFailures / stage1QuoteAttempts : 0;
  const stage1PassRate =
    stageCounts.stage1Entered > 0
      ? stageCounts.stage1Passed / stageCounts.stage1Entered
      : 1;
  const quoteCoverageDegraded =
    stage1QuoteAttempts >= 10 &&
    stage1QuoteFailureRate >= 0.5 &&
    stage1PassRate < 0.5;
  const stage2RequestDegraded = stage2RequestFailures.length > 0;
  const quotaLimited =
    stage2RequestFailures.some((item) => item.quotaExceeded) ||
    stage3BarLoadFailures.some((failure) =>
      failure.failedViews.some((view) =>
        view.status === 429 ||
        (view.status === 403 && (view.loadIssue?.toLowerCase().includes("quota exceeded") ?? false)) ||
        (view.loadIssue?.toLowerCase().includes("quota exceeded") ?? false)
      )
    );
  const stage3LoadBlocked =
    stageCounts.stage2Passed > 0 &&
    stage3BarLoadFailures.length === stageCounts.stage2Passed;
  const degraded =
    quoteCoverageDegraded ||
    stage2RequestDegraded ||
    stage3BarLoadFailures.length > 0;
  const severe =
    quoteCoverageDegraded ||
    quotaLimited ||
    stage2RequestFailures.some((item) => item.status === 429) ||
    stage3LoadBlocked;
  const summaryParts: string[] = [];

  if (quoteCoverageDegraded) {
    summaryParts.push(
      `Stage 1 quote coverage was degraded: ${stage1QuoteFailures}/${stage1QuoteAttempts} quote requests failed (${formatPercent(stage1QuoteFailureRate)}), with ${symbolsRecoveredByFallback} symbols recovered from fallback bars.`,
    );
  }
  if (stage2RequestFailures.length > 0) {
    const rateLimited = stage2RequestFailures.filter((item) => item.status === 429 || item.quotaExceeded);
    const sample = stage2RequestFailures
      .slice(0, 5)
      .map((item) =>
        `${item.symbol} ${item.endpoint} HTTP ${item.status}${item.quotaExceeded ? " quota exceeded" : ""}${item.errorMessage ? ` ${item.errorMessage}` : ""}`
      )
      .join(", ");
    summaryParts.push(
      `Stage 2 option-data requests were degraded: ${stage2RequestFailures.length} transient request failures${rateLimited.length > 0 ? `, including ${rateLimited.length} quota/rate-limit responses` : ""}${sample ? ` (${sample})` : ""}.`,
    );
  }
  if (stage3BarLoadFailures.length > 0) {
    summaryParts.push(
      `Stage 3 could not load the required chart bars for ${stage3BarLoadFailures
        .map((item) => item.symbol)
        .join(", ")}.`,
    );
  }

  return {
    degraded,
    severe,
    quotaLimited,
    summary: summaryParts.join(" ") || "Market data coverage looked usable for this scan.",
    stage1QuoteFailureRate,
    stage1PassRate,
    stage2RequestFailures,
    stage3BarLoadFailures,
  };
}

function buildEffectiveCoverageSummary(symbolsRecoveredByFallback: number): string {
  return symbolsRecoveredByFallback > 0
    ? `Recovered ${symbolsRecoveredByFallback} symbols via fallback quote/bar data.`
    : "Stage 1 quote handling did not reduce scan coverage.";
}

function tierSummaryInformationScore(summary: TierSummary): number {
  return (
    summary.counts.finalRanking * 8 +
    summary.counts.finalistsReviewed * 6 +
    summary.counts.stage3Passed * 4 +
    summary.counts.stage2Passed * 2 +
    summary.counts.stage1Passed
  );
}

function mergeTierSummary(
  existing: TierSummary | null,
  incoming: TierSummary,
): TierSummary {
  if (!existing) {
    return incoming;
  }

  const incomingMoreInformative =
    tierSummaryInformationScore(incoming) >= tierSummaryInformationScore(existing);
  return {
    ...existing,
    counts: mergeStageCounts(existing.counts, incoming.counts),
    quoteFailures: existing.quoteFailures + incoming.quoteFailures,
    fallbackRecoveries: existing.fallbackRecoveries + incoming.fallbackRecoveries,
    symbols: mergeStageSymbols(existing.symbols, incoming.symbols),
    finalistsReviewed: [
      ...existing.finalistsReviewed,
      ...incoming.finalistsReviewed,
    ],
    concludedWith:
      incoming.concludedWith === "confirmed" || existing.concludedWith !== "confirmed"
        ? incoming.concludedWith
        : existing.concludedWith,
    winner: incoming.winner ?? existing.winner,
    noTradeReason: incomingMoreInformative
      ? incoming.noTradeReason
      : existing.noTradeReason,
  };
}

function sortFinalRanking(
  ranking: StarterUniverseTelemetry["finalRankingDebug"],
): StarterUniverseTelemetry["finalRankingDebug"] {
  return [...ranking].sort((left, right) => {
    const scoreDelta = (right.score ?? Number.NEGATIVE_INFINITY) -
      (left.score ?? Number.NEGATIVE_INFINITY);
    return scoreDelta !== 0 ? scoreDelta : left.symbol.localeCompare(right.symbol);
  });
}

function selectBestRejectedCandidates(
  reviewed: StarterUniverseTelemetry["reviewedFinalistOutcomes"],
): StarterUniverseTelemetry["bestRejectedCandidates"] {
  const bestBySymbol = new Map<string, StarterUniverseTelemetry["reviewedFinalistOutcomes"][number]>();
  for (const finalist of reviewed) {
    if (finalist.conclusion === "confirmed") {
      continue;
    }
    const existing = bestBySymbol.get(finalist.symbol);
    if (!existing || finalist.rankingScore > existing.rankingScore) {
      bestBySymbol.set(finalist.symbol, finalist);
    }
  }

  return [...bestBySymbol.values()]
    .sort((left, right) => {
      const scoreDelta = right.rankingScore - left.rankingScore;
      return scoreDelta !== 0 ? scoreDelta : left.symbol.localeCompare(right.symbol);
    })
    .slice(0, 5)
    .map((item) => ({
      symbol: item.symbol,
      tier: item.tier,
      tierLabel: item.tierLabel,
      rejectionReasons: item.confirmationFailureReasons,
    }));
}

function buildCrossTierFinalistSummary(
  finalists: StarterUniverseTelemetry["bestRejectedCandidates"],
): string | null {
  if (finalists.length === 0) {
    return null;
  }

  return `The closest reviewed candidates were ${finalists
    .map((item) => `${item.symbol} (${item.tierLabel})`)
    .join(", ")}.`;
}

function buildManualNoTradeReason(
  chunkCount: number,
  telemetry: StarterUniverseTelemetry,
): string {
  const scannedText = scanUniverseLabel();
  const counts = telemetry.stageCounts;
  const funnelSummary =
    telemetry.bestRejectedCandidates.length > 0
      ? ""
      : counts.finalRanking > 0
        ? " Ranked finalists existed, but none survived deterministic confirmation and trade-card validation."
        : counts.stage3Passed > 0
          ? " Stage 3 produced pass-through names, but none remained eligible for final confirmation."
          : counts.stage2Passed > 0
            ? " Some symbols passed options tradability, but none survived Stage 3 chart review."
            : " No symbol cleared the options-tradability gate after the broad symbol scan.";
  const closestCandidates = telemetry.bestRejectedCandidates.length > 0
    ? ` Closest reviewed candidates: ${telemetry.bestRejectedCandidates
        .map((item) => `${item.symbol} (${item.tierLabel})`)
        .join(", ")}.`
    : "";
  const dataHealth = telemetry.dataHealth.degraded
    ? ` Market data was degraded during the scan: ${telemetry.dataHealth.summary}`
    : "";

  return `Manual scan completed ${chunkCount} chunk(s) over ${scannedText}. No confirmed trade-card-ready setup survived the scanner, confirmation, and trade-card gates.${funnelSummary}${closestCandidates}${dataHealth}`;
}

function describeReviewedOutcome(
  outcome: StarterUniverseTelemetry["reviewedFinalistOutcomes"][number],
): string {
  if (outcome.candidateBlockedPostConfirmation) {
    return `${outcome.symbol} blocked after confirmation`;
  }
  if (outcome.candidateConfirmedInPrompt2) {
    return `${outcome.symbol} confirmed`;
  }
  return `${outcome.symbol} rejected in confirmation`;
}

function buildSelectedManualScanReason(params: {
  selectedSymbol: string;
  scannedText: string;
  telemetry: StarterUniverseTelemetry;
  fallbackReason: string;
}): string {
  const reviewedBySymbol = new Map(
    params.telemetry.reviewedFinalistOutcomes.map((item) => [item.symbol, item]),
  );
  const reviewedInGlobalRankOrder = params.telemetry.finalRankingDebug
    .map((item) => reviewedBySymbol.get(item.symbol) ?? null)
    .filter(
      (
        item,
      ): item is StarterUniverseTelemetry["reviewedFinalistOutcomes"][number] =>
        item !== null,
    );
  const selectedIndex = reviewedInGlobalRankOrder.findIndex(
    (item) => item.symbol === params.selectedSymbol,
  );
  const selectedOutcome =
    selectedIndex >= 0 ? reviewedInGlobalRankOrder[selectedIndex] ?? null : null;
  const earlierOutcomes =
    selectedIndex > 0 ? reviewedInGlobalRankOrder.slice(0, selectedIndex) : [];
  const rankingScore =
    selectedOutcome?.rankingScore ??
    params.telemetry.finalRankingDebug.find(
      (item) => item.symbol === params.selectedSymbol,
    )?.score ??
    null;
  const reviewedText = reviewedInGlobalRankOrder.map((item) => item.symbol).join(", ");
  const rankScoreText =
    rankingScore === null ? "" : `; rank score ${rankingScore.toFixed(2)}`;
  const earlierText =
    earlierOutcomes.length > 0
      ? ` after ${earlierOutcomes.map((item) => describeReviewedOutcome(item)).join(", ")}`
      : "";
  const selectedDetail = selectedOutcome?.reason ?? params.fallbackReason;

  return `Selected ${params.selectedSymbol} as the best confirmed setup after scanning ${params.scannedText}. Finalist confirmation used the merged configured-universe ladder (reviewed: ${reviewedText || params.selectedSymbol}; selected: ${params.selectedSymbol}${rankScoreText}). ${params.selectedSymbol} was the first trade-card-ready survivor in global rank order${earlierText}. ${selectedDetail}`;
}

function buildEmptyTelemetry(): StarterUniverseTelemetry {
  const stageCounts = buildEmptyStageCounts();
  const stageSymbols = buildEmptyStageSymbols();
  const dataHealth = buildMergedDataHealth({
    stageCounts,
    stage1QuoteAttempts: 0,
    stage1QuoteFailures: 0,
    symbolsRecoveredByFallback: 0,
    stage2RequestFailures: [],
    stage3BarLoadFailures: [],
  });
  return {
    stageCounts,
    stageSymbols,
    finalistsReviewedDebug: [],
    stage3PassedDetails: [],
    finalRankingDebug: [],
    rejectionSummaries: buildEmptyRejectionSummaries(),
    stage1QuoteAttempts: 0,
    stage1QuoteFailures: 0,
    stage1QuoteFallbackUsed: 0,
    symbolsRecoveredByFallback: 0,
    perTierQuoteFailures: {},
    perTierFallbackRecoveries: {},
    effectiveCoverageSummary: buildEffectiveCoverageSummary(0),
    dataHealth,
    nearMisses: [],
    consistencyChecks: [],
    finalSelectedSymbol: null,
    topRankedSymbol: null,
    scannedTiers: [],
    winningTier: null,
    finalSelectionSourceTier: null,
    finalOutcomeSource: "cross_tier_no_trade",
    tierSummaries: [],
    tierStageCounts: {},
    tierFinalistsReviewed: {},
    cumulativeStageCounts: stageCounts,
    finalNoTradeExplanation: null,
    reviewedFinalistOutcomes: [],
    bestReviewedFinalistsAcrossTiers: [],
    bestRejectedCandidates: [],
    crossTierFinalistSummary: null,
  };
}

function mergeManualTelemetry(
  current: StarterUniverseTelemetry | null,
  incoming: StarterUniverseTelemetry,
  tierKey: ScanUniverseTierKey,
): StarterUniverseTelemetry {
  const existing = current ?? buildEmptyTelemetry();
  const stageCounts = mergeStageCounts(existing.stageCounts, incoming.stageCounts);
  const stageSymbols = mergeStageSymbols(existing.stageSymbols, incoming.stageSymbols);
  const stage1QuoteAttempts = existing.stage1QuoteAttempts + incoming.stage1QuoteAttempts;
  const stage1QuoteFailures = existing.stage1QuoteFailures + incoming.stage1QuoteFailures;
  const stage1QuoteFallbackUsed =
    existing.stage1QuoteFallbackUsed + incoming.stage1QuoteFallbackUsed;
  const symbolsRecoveredByFallback =
    existing.symbolsRecoveredByFallback + incoming.symbolsRecoveredByFallback;
  const stage2RequestFailures = [
    ...existing.dataHealth.stage2RequestFailures,
    ...incoming.dataHealth.stage2RequestFailures,
  ];
  const stage3BarLoadFailures = [
    ...existing.dataHealth.stage3BarLoadFailures,
    ...incoming.dataHealth.stage3BarLoadFailures,
  ];
  const tierSummary = incoming.tierSummaries.find((item) => item.tier === tierKey) ?? null;
  const tierSummaryByKey = new Map(
    existing.tierSummaries.map((item) => [item.tier, item]),
  );
  if (tierSummary) {
    tierSummaryByKey.set(
      tierKey,
      mergeTierSummary(tierSummaryByKey.get(tierKey) ?? null, tierSummary),
    );
  }
  const tierSummaries = SCAN_UNIVERSE_TIERS
    .map((tier) => tierSummaryByKey.get(tier.key) ?? null)
    .filter((item): item is TierSummary => item !== null);
  const finalRankingDebug = sortFinalRanking([
    ...existing.finalRankingDebug,
    ...incoming.finalRankingDebug,
  ]);
  const reviewedFinalistOutcomes = [
    ...existing.reviewedFinalistOutcomes,
    ...incoming.reviewedFinalistOutcomes,
  ];
  const bestRejectedCandidates = selectBestRejectedCandidates(reviewedFinalistOutcomes);
  const dataHealth = buildMergedDataHealth({
    stageCounts,
    stage1QuoteAttempts,
    stage1QuoteFailures,
    symbolsRecoveredByFallback,
    stage2RequestFailures,
    stage3BarLoadFailures,
  });

  return {
    ...existing,
    stageCounts,
    stageSymbols,
    finalistsReviewedDebug: [
      ...existing.finalistsReviewedDebug,
      ...incoming.finalistsReviewedDebug,
    ],
    stage3PassedDetails: [
      ...existing.stage3PassedDetails,
      ...incoming.stage3PassedDetails,
    ],
    finalRankingDebug,
    rejectionSummaries: mergeRejectionSummaries(
      existing.rejectionSummaries,
      incoming.rejectionSummaries,
    ),
    stage1QuoteAttempts,
    stage1QuoteFailures,
    stage1QuoteFallbackUsed,
    symbolsRecoveredByFallback,
    perTierQuoteFailures: {
      ...existing.perTierQuoteFailures,
      [tierKey]:
        (existing.perTierQuoteFailures[tierKey] ?? 0) +
        (tierSummary?.quoteFailures ?? 0),
    },
    perTierFallbackRecoveries: {
      ...existing.perTierFallbackRecoveries,
      [tierKey]:
        (existing.perTierFallbackRecoveries[tierKey] ?? 0) +
        (tierSummary?.fallbackRecoveries ?? 0),
    },
    effectiveCoverageSummary: buildEffectiveCoverageSummary(symbolsRecoveredByFallback),
    dataHealth,
    nearMisses: [...existing.nearMisses, ...incoming.nearMisses],
    consistencyChecks: [...existing.consistencyChecks, ...incoming.consistencyChecks],
    topRankedSymbol: finalRankingDebug[0]?.symbol ?? null,
    scannedTiers: uniqueStrings([...existing.scannedTiers, tierKey]),
    tierSummaries,
    tierStageCounts: Object.fromEntries(
      tierSummaries.map((summary) => [summary.tier, summary.counts]),
    ),
    tierFinalistsReviewed: Object.fromEntries(
      tierSummaries.map((summary) => [summary.tier, summary.finalistsReviewed]),
    ),
    cumulativeStageCounts: stageCounts,
    reviewedFinalistOutcomes,
    bestReviewedFinalistsAcrossTiers: reviewedFinalistOutcomes.map((item) => item.symbol),
    bestRejectedCandidates,
    crossTierFinalistSummary: buildCrossTierFinalistSummary(bestRejectedCandidates),
  };
}

function markTradeCardBlock(
  scan: ScanResult,
  telemetry: StarterUniverseTelemetry,
  blockerReason: string,
): StarterUniverseTelemetry {
  if (!scan.ticker) {
    return telemetry;
  }

  const reviewedFinalistOutcomes = telemetry.reviewedFinalistOutcomes.map((item) =>
    item.symbol === scan.ticker
      ? {
          ...item,
          candidateBlockedPostConfirmation: true,
          blockedConfirmationReason: blockerReason,
          tierAbandonedAfterBlock: true,
          scanContinuedAfterBlock: true,
          survivedFinalSelection: false,
          conclusion: "no_trade_today" as const,
          reason: blockerReason,
        }
      : item,
  );
  const bestRejectedCandidates = selectBestRejectedCandidates(reviewedFinalistOutcomes);
  return {
    ...telemetry,
    finalSelectedSymbol: null,
    winningTier: null,
    finalSelectionSourceTier: null,
    finalOutcomeSource: "tier_blocked_post_confirmation",
    finalistsReviewedDebug: mergeFinalizedAsymmetryIntoFinalistsReviewedDebug(
      telemetry.finalistsReviewedDebug,
      reviewedFinalistOutcomes,
    ),
    reviewedFinalistOutcomes,
    bestReviewedFinalistsAcrossTiers: reviewedFinalistOutcomes.map((item) => item.symbol),
    bestRejectedCandidates,
    crossTierFinalistSummary: buildCrossTierFinalistSummary(bestRejectedCandidates),
  };
}

function finalizeManualTelemetry(
  telemetry: StarterUniverseTelemetry | null,
  params: {
    selectedSymbol: string | null;
    winningTier: ScanUniverseTierKey | null;
    noTradeReason: string | null;
  },
): StarterUniverseTelemetry {
  const accumulated = telemetry ?? buildEmptyTelemetry();
  const finalRankingDebug = sortFinalRanking(accumulated.finalRankingDebug);
  const topRankedSymbol = finalRankingDebug[0]?.symbol ?? null;
  const reviewedFinalistOutcomes = accumulated.reviewedFinalistOutcomes.map((item) => ({
    ...item,
    survivedFinalSelection:
      params.selectedSymbol !== null && item.symbol === params.selectedSymbol,
  }));
  const bestRejectedCandidates = selectBestRejectedCandidates(reviewedFinalistOutcomes);
  const tierSummaries = accumulated.tierSummaries.map((summary) =>
    summary.tier === params.winningTier && params.selectedSymbol
      ? {
          ...summary,
          concludedWith: "confirmed" as const,
          winner: params.selectedSymbol,
          noTradeReason: null,
        }
      : summary,
  );

  return {
    ...accumulated,
    finalRankingDebug: finalRankingDebug.map((item, index) => ({
      ...item,
      topRankedCandidate: index === 0,
      confirmedFinalSelection:
        params.selectedSymbol !== null && item.symbol === params.selectedSymbol,
      selected: index === 0,
    })),
    finalSelectedSymbol: params.selectedSymbol,
    topRankedSymbol,
    winningTier: params.winningTier,
    finalSelectionSourceTier: params.winningTier,
    finalOutcomeSource:
      params.selectedSymbol !== null
        ? "tier_confirmed"
        : reviewedFinalistOutcomes.some((item) => item.candidateBlockedPostConfirmation)
          ? "tier_blocked_post_confirmation"
          : "cross_tier_no_trade",
    tierSummaries,
    tierStageCounts: Object.fromEntries(
      tierSummaries.map((summary) => [summary.tier, summary.counts]),
    ),
    tierFinalistsReviewed: Object.fromEntries(
      tierSummaries.map((summary) => [summary.tier, summary.finalistsReviewed]),
    ),
    finalNoTradeExplanation: params.noTradeReason,
    reviewedFinalistOutcomes,
    bestReviewedFinalistsAcrossTiers: reviewedFinalistOutcomes.map((item) => item.symbol),
    bestRejectedCandidates,
    crossTierFinalistSummary: buildCrossTierFinalistSummary(bestRejectedCandidates),
  };
}

function readManualScanState(value: unknown): ManualScanState | null {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ManualScanState>
    : null;
  if (
    !record ||
    record.version !== 2 ||
    typeof record.scanRunId !== "string" ||
    typeof record.prompt !== "string"
  ) {
    return null;
  }

  return {
    version: 2,
    scanRunId: record.scanRunId,
    prompt: record.prompt,
    status: record.status === "completed" ? "completed" : "running",
    tierIndex: typeof record.tierIndex === "number" && Number.isFinite(record.tierIndex)
      ? Math.max(0, Math.floor(record.tierIndex))
      : 0,
    tierCursor: typeof record.tierCursor === "number" && Number.isFinite(record.tierCursor)
      ? Math.max(0, Math.floor(record.tierCursor))
      : 0,
    chunkCount: typeof record.chunkCount === "number" && Number.isFinite(record.chunkCount)
      ? Math.max(0, Math.floor(record.chunkCount))
      : 0,
    scannedSymbolCount: typeof record.scannedSymbolCount === "number" && Number.isFinite(record.scannedSymbolCount)
      ? Math.max(0, Math.floor(record.scannedSymbolCount))
      : 0,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : new Date().toISOString(),
    bestConfirmed: record.bestConfirmed ?? null,
    chunkSummaries: Array.isArray(record.chunkSummaries)
      ? record.chunkSummaries.slice(-80) as ManualScanChunkSummary[]
      : [],
    accumulatedTelemetry: record.accumulatedTelemetry ?? null,
    latestDataHealth: record.latestDataHealth ?? null,
    resumeAfter: typeof record.resumeAfter === "string" ? record.resumeAfter : null,
    quotaPauseCount: typeof record.quotaPauseCount === "number" && Number.isFinite(record.quotaPauseCount)
      ? Math.max(0, Math.floor(record.quotaPauseCount))
      : 0,
    lastQuotaReason: typeof record.lastQuotaReason === "string" ? record.lastQuotaReason : null,
    finalResponse: record.finalResponse ?? null,
  };
}

function createInitialState(body: unknown): ManualScanState {
  return {
    version: 2,
    scanRunId: buildScanRunId(),
    prompt: readPrompt(body),
    status: "running",
    tierIndex: 0,
    tierCursor: 0,
    chunkCount: 0,
    scannedSymbolCount: 0,
    startedAt: new Date().toISOString(),
    bestConfirmed: null,
    chunkSummaries: [],
    accumulatedTelemetry: null,
    latestDataHealth: null,
    resumeAfter: null,
    quotaPauseCount: 0,
    lastQuotaReason: null,
    finalResponse: null,
  };
}

function normalizeScanPosition(state: ManualScanState): ManualScanState {
  let tierIndex = state.tierIndex;
  let tierCursor = state.tierCursor;

  while (tierIndex < SCAN_UNIVERSE_TIERS.length) {
    const tier = SCAN_UNIVERSE_TIERS[tierIndex];
    if (!tier || tierCursor < tier.symbols.length) {
      break;
    }
    tierIndex += 1;
    tierCursor = 0;
  }

  return {
    ...state,
    tierIndex,
    tierCursor,
    scannedSymbolCount:
      tierIndex >= SCAN_UNIVERSE_TIERS.length
        ? totalSymbolCount()
        : countSymbolsBeforeTier(tierIndex) + tierCursor,
  };
}

function buildExcludedTickers(tierIndex: number, tierCursor: number): string[] {
  return [
    ...SCAN_UNIVERSE_TIERS.slice(0, tierIndex).flatMap((tier) => tier.symbols),
    ...(SCAN_UNIVERSE_TIERS[tierIndex]?.symbols.slice(0, tierCursor) ?? []),
  ];
}

function readSelectedRankingScore(
  scan: ScanResult,
  telemetry: StarterUniverseTelemetry | null,
): number | null {
  const reviewed = telemetry?.reviewedFinalistOutcomes ?? [];
  const selectedOutcome = reviewed.find((item) =>
    item.survivedFinalSelection || item.symbol === scan.ticker
  );
  if (typeof selectedOutcome?.rankingScore === "number") {
    return selectedOutcome.rankingScore;
  }

  const ranking = telemetry?.finalRankingDebug ?? [];
  const selectedRanking = ranking.find((item) =>
    item.confirmedFinalSelection || item.symbol === scan.ticker
  );
  return typeof selectedRanking?.score === "number" ? selectedRanking.score : null;
}

function buildProgress(state: ManualScanState, text: string): ManualScanProgress {
  const tier = SCAN_UNIVERSE_TIERS[state.tierIndex] ?? null;
  const nextPollDelayMs = state.resumeAfter
    ? Math.max(0, new Date(state.resumeAfter).getTime() - Date.now())
    : 0;
  return {
    text,
    tier: tier?.label ?? null,
    scannedSymbolCount: state.scannedSymbolCount,
    totalSymbolCount: totalSymbolCount(),
    chunkCount: state.chunkCount,
    bestSymbol: state.bestConfirmed?.scan.ticker ?? null,
    ...(nextPollDelayMs > 0 ? { nextPollDelayMs } : {}),
  };
}

function isQuotaLimitedTelemetry(telemetry: StarterUniverseTelemetry | null): boolean {
  return telemetry?.dataHealth.quotaLimited === true;
}

function isQuotaLimitedReason(reason: string | null): boolean {
  return reason?.toLowerCase().includes("quota exceeded") ?? false;
}

function buildQuotaPauseReason(
  telemetry: StarterUniverseTelemetry | null,
  tradeCardBlockReason: string | null,
): string {
  if (isQuotaLimitedReason(tradeCardBlockReason)) {
    return tradeCardBlockReason as string;
  }
  return telemetry?.dataHealth.summary ?? "TradeStation quota was exceeded during the scan.";
}

function buildResumeAfter(): string {
  return new Date(Date.now() + readQuotaBackoffMs()).toISOString();
}

function buildQuotaPausedResponse(state: ManualScanState): Record<string, unknown> {
  const best = state.bestConfirmed?.scan.ticker ?? "none yet";
  const tier = SCAN_UNIVERSE_TIERS[state.tierIndex] ?? null;
  const progress = buildProgress(
    state,
    `Paused for TradeStation quota recovery while scanning ${tier?.label ?? "the universe"}; best confirmed setup so far: ${best}. ${state.lastQuotaReason ?? ""}`.trim(),
  );

  return {
    scan_run_id: state.scanRunId,
    prompt: state.prompt,
    status: state.status,
    progress,
    state,
    latestChunk: state.chunkSummaries.at(-1) ?? null,
    dataHealth: state.latestDataHealth,
  };
}

async function maybeBuildTradeCard(
  scan: ScanResult,
): Promise<TradeConstructionResult | null> {
  if (
    scan.conclusion !== "confirmed" ||
    !scan.ticker ||
    !scan.direction ||
    !scan.confidence
  ) {
    return null;
  }

  return await constructTradeCard({
    prompt: `build trade ${scan.ticker}`,
    confirmedDirection: scan.direction,
    confirmedConfidence: scan.confidence,
  });
}

async function finalizeState(state: ManualScanState): Promise<ManualScanState> {
  const best = state.bestConfirmed;
  const scannedText = scanUniverseLabel();

  if (!best) {
    const provisionalTelemetry = finalizeManualTelemetry(state.accumulatedTelemetry, {
      selectedSymbol: null,
      winningTier: null,
      noTradeReason: null,
    });
    const noTradeReason = buildManualNoTradeReason(state.chunkCount, provisionalTelemetry);
    const telemetry = finalizeManualTelemetry(state.accumulatedTelemetry, {
      selectedSymbol: null,
      winningTier: null,
      noTradeReason,
    });
    const scan: ScanResult = {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: noTradeReason,
      telemetry,
    };
    const presentationSummary = buildWorkflowPresentationSummary({
      scan,
      telemetry,
      tradeCard: null,
    });
    const progress = buildProgress(state, "Manual scan complete: no confirmed setup survived all gates.");
    const finalResponse: ManualScanCompletedPayload = {
      scan_run_id: state.scanRunId,
      prompt: state.prompt,
      status: "completed",
      progress,
      scan,
      tradeCard: null,
      tradeRecommendation: null,
      telemetry,
      presentationSummary,
      manualScan: {
        chunkCount: state.chunkCount,
        scannedSymbolCount: totalSymbolCount(),
        totalSymbolCount: totalSymbolCount(),
        bestSymbol: null,
        chunkSummaries: state.chunkSummaries,
      },
    };
    return {
      ...state,
      status: "completed",
      scannedSymbolCount: totalSymbolCount(),
      finalResponse,
    };
  }

  const winningTier = best.chunkSummary.tier as ScanUniverseTierKey;
  const telemetry = finalizeManualTelemetry(state.accumulatedTelemetry, {
    selectedSymbol: best.scan.ticker,
    winningTier,
    noTradeReason: null,
  });
  const selectedSymbol = best.scan.ticker;
  if (!selectedSymbol) {
    throw new Error("Manual scan best candidate was missing a ticker.");
  }
  const scan: ScanResult = {
    ...best.scan,
    reason: buildSelectedManualScanReason({
      selectedSymbol,
      scannedText,
      telemetry,
      fallbackReason: best.scan.reason,
    }),
    telemetry,
  };
  const presentationSummary = buildWorkflowPresentationSummary({
    scan,
    telemetry,
    tradeCard: best.tradeCard,
  });
  const signalSnapshotJson = {
    scan,
    telemetry,
    tradeCard: best.tradeCard,
    presentationSummary,
    manualScan: {
      chunkCount: state.chunkCount,
      chunkSummaries: state.chunkSummaries,
    },
  };
  let tradeRecommendation = null;

  try {
    tradeRecommendation = await createTradeRecommendation({
      scan_run_id: state.scanRunId,
      prompt: state.prompt,
      planned_trade: best.tradeCard.plannedJournalFields,
      signal_snapshot_json: signalSnapshotJson,
    });
  } catch (error) {
    console.warn("Failed to persist manual scan recommendation history.", error);
  }

  const progress = buildProgress(
    {
      ...state,
      scannedSymbolCount: totalSymbolCount(),
    },
    `Manual scan complete: best confirmed setup is ${scan.ticker}.`,
  );
  const finalResponse: ManualScanCompletedPayload = {
    scan_run_id: state.scanRunId,
    prompt: state.prompt,
    status: "completed",
    progress,
    scan,
    tradeCard: best.tradeCard,
    journalPlannedTrade: best.tradeCard.plannedJournalFields,
    tradeRecommendation,
    telemetry,
    presentationSummary,
    manualScan: {
      chunkCount: state.chunkCount,
      scannedSymbolCount: totalSymbolCount(),
      totalSymbolCount: totalSymbolCount(),
      bestSymbol: scan.ticker,
      chunkSummaries: state.chunkSummaries,
    },
  };

  return {
    ...state,
    status: "completed",
    scannedSymbolCount: totalSymbolCount(),
    finalResponse,
  };
}

function completeQuotaStoppedState(
  state: ManualScanState,
  telemetry: StarterUniverseTelemetry | null,
  noTradeReason: string,
): ManualScanState {
  const finalizedTelemetry = finalizeManualTelemetry(telemetry, {
    selectedSymbol: null,
    winningTier: null,
    noTradeReason,
  });
  const scan: ScanResult = {
    ticker: null,
    direction: null,
    confidence: null,
    conclusion: "no_trade_today",
    reason: noTradeReason,
    telemetry: finalizedTelemetry,
  };
  const completedState = normalizeScanPosition({
    ...state,
    status: "completed",
    tierIndex: SCAN_UNIVERSE_TIERS.length,
    accumulatedTelemetry: finalizedTelemetry,
    latestDataHealth: finalizedTelemetry.dataHealth,
    resumeAfter: null,
  });
  const presentationSummary = buildWorkflowPresentationSummary({
    scan,
    telemetry: finalizedTelemetry,
    tradeCard: null,
  });
  const finalResponse: ManualScanCompletedPayload = {
    scan_run_id: completedState.scanRunId,
    prompt: completedState.prompt,
    status: "completed",
    progress: buildProgress(completedState, "Manual scan stopped because TradeStation quota remained unavailable."),
    scan,
    tradeCard: null,
    tradeRecommendation: null,
    telemetry: finalizedTelemetry,
    presentationSummary,
    manualScan: {
      chunkCount: completedState.chunkCount,
      scannedSymbolCount: completedState.scannedSymbolCount,
      totalSymbolCount: totalSymbolCount(),
      bestSymbol: null,
      chunkSummaries: completedState.chunkSummaries,
    },
  };

  return {
    ...completedState,
    finalResponse,
  };
}

async function advanceState(initialState: ManualScanState): Promise<ManualScanState> {
  const state = normalizeScanPosition(initialState);
  if (state.status === "completed") {
    return state;
  }
  if (state.resumeAfter && new Date(state.resumeAfter).getTime() > Date.now()) {
    return state;
  }
  const runningState = state.resumeAfter ? { ...state, resumeAfter: null } : state;
  if (runningState.tierIndex >= SCAN_UNIVERSE_TIERS.length) {
    return await finalizeState(runningState);
  }

  const tier = SCAN_UNIVERSE_TIERS[runningState.tierIndex];
  if (!tier) {
    return await finalizeState({
      ...runningState,
      tierIndex: SCAN_UNIVERSE_TIERS.length,
    });
  }
  const chunkSize = Math.min(readChunkSize(), tier.symbols.length - runningState.tierCursor);
  const from = runningState.tierCursor;
  const to = Math.min(tier.symbols.length, from + chunkSize);
  const chunkSymbols = tier.symbols.slice(from, to);
  const startedAt = Date.now();
  const scan = await runScan({
    prompt: runningState.prompt,
    excludedTickers: buildExcludedTickers(runningState.tierIndex, runningState.tierCursor),
    scanTierLimit: runningState.tierIndex + 1,
    maxSymbolsPerTier: chunkSize,
  });
  if (!scan.telemetry) {
    throw new Error("Manual scan did not receive TradeStation universe telemetry; market data was unavailable for this chunk.");
  }
  let telemetry = scan.telemetry;
  const rankingScore = readSelectedRankingScore(scan, telemetry);
  let tradeCard: TradeConstructionResult | null = null;
  let tradeCardBlockReason: string | null = null;

  try {
    tradeCard = await maybeBuildTradeCard(scan);
  } catch (error) {
    tradeCardBlockReason = readErrorMessage(error);
    telemetry = markTradeCardBlock(scan, telemetry, tradeCardBlockReason);
  }

  if (isQuotaLimitedTelemetry(telemetry) || isQuotaLimitedReason(tradeCardBlockReason)) {
    const quotaPauseCount = runningState.quotaPauseCount + 1;
    const quotaReason = buildQuotaPauseReason(telemetry, tradeCardBlockReason);
    const latestDataHealth = telemetry?.dataHealth ?? runningState.latestDataHealth;
    if (quotaPauseCount <= readManualScanMaxQuotaPauses()) {
      return normalizeScanPosition({
        ...runningState,
        resumeAfter: buildResumeAfter(),
        quotaPauseCount,
        lastQuotaReason: quotaReason,
        latestDataHealth,
      });
    }

    const accumulatedTelemetry = telemetry
      ? mergeManualTelemetry(runningState.accumulatedTelemetry, telemetry, tier.key)
      : runningState.accumulatedTelemetry;
    const noTradeReason = `Manual scan stopped after ${readManualScanMaxQuotaPauses()} TradeStation quota pause(s). ${quotaReason}`;
    return completeQuotaStoppedState({
      ...runningState,
      accumulatedTelemetry,
      latestDataHealth,
      quotaPauseCount,
      lastQuotaReason: quotaReason,
      finalResponse: null,
    }, accumulatedTelemetry, noTradeReason);
  }

  const chunkSummary: ManualScanChunkSummary = {
    tier: tier.key,
    label: tier.label,
    from: from + 1,
    to,
    symbols: [...chunkSymbols],
    conclusion: scan.conclusion === "confirmed" && !tradeCard
      ? "blocked_after_confirmation"
      : scan.conclusion,
    selectedSymbol: scan.ticker,
    rankingScore,
    tradeCardReady: tradeCard !== null,
    reason: tradeCardBlockReason ?? scan.reason,
    durationMs: Date.now() - startedAt,
  };
  const candidateScore = rankingScore ?? 0;
  const bestConfirmed =
    tradeCard && (!runningState.bestConfirmed || candidateScore > runningState.bestConfirmed.score)
      ? {
          score: candidateScore,
          scan,
          telemetry,
          tradeCard,
          chunkSummary,
        }
      : runningState.bestConfirmed;
  const accumulatedTelemetry = mergeManualTelemetry(
    runningState.accumulatedTelemetry,
    telemetry,
    tier.key,
  );
  const nextState = normalizeScanPosition({
    ...runningState,
    tierCursor: to,
    chunkCount: runningState.chunkCount + 1,
    bestConfirmed,
    chunkSummaries: [...runningState.chunkSummaries, chunkSummary].slice(-80),
    accumulatedTelemetry,
    latestDataHealth: accumulatedTelemetry.dataHealth,
    quotaPauseCount: 0,
    lastQuotaReason: null,
  });

  if (nextState.tierIndex >= SCAN_UNIVERSE_TIERS.length) {
    return await finalizeState(nextState);
  }

  return nextState;
}

function buildRunningResponse(state: ManualScanState): Record<string, unknown> {
  if (state.resumeAfter && new Date(state.resumeAfter).getTime() > Date.now()) {
    return buildQuotaPausedResponse(state);
  }
  const best = state.bestConfirmed?.scan.ticker ?? "none yet";
  const tier = SCAN_UNIVERSE_TIERS[state.tierIndex] ?? null;
  const progress = buildProgress(
    state,
    `Scanning ${tier?.label ?? "final checks"}: ${state.scannedSymbolCount}/${totalSymbolCount()} symbols checked; best confirmed setup so far: ${best}.`,
  );

  return {
    scan_run_id: state.scanRunId,
    prompt: state.prompt,
    status: state.status,
    progress,
    state,
    latestChunk: state.chunkSummaries.at(-1) ?? null,
    dataHealth: state.latestDataHealth,
  };
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 404, {
      error: true,
      message: "Use POST /api/manual-scan",
    });
    return;
  }

  try {
    const payload = (req.body ?? {}) as ManualScanRequestBody;
    const initialState = readManualScanState(payload.state) ?? await createInitialState(req.body);
    const nextState = await advanceState(initialState);

    if (nextState.status === "completed" && nextState.finalResponse) {
      sendJson(res, 200, {
        ...nextState.finalResponse,
        state: nextState,
      });
      return;
    }

    sendJson(res, 200, buildRunningResponse(nextState));
  } catch (error) {
    console.error("Failed to run /api/manual-scan", error);
    sendJson(res, 500, {
      error: true,
      message: readErrorMessage(error),
      stage: "manual_scan_handler",
    });
  }
}
