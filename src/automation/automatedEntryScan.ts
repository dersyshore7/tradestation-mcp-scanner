import {
  extractFinalizedTradeGeometryFromTelemetry,
  runScan,
  type ScanInput,
  type ScanLearningPreference,
  type ScanResult,
  type StarterUniverseTelemetry,
} from "../app/runScan.js";
import {
  constructTradeCard,
  type TradeConstructionResult,
} from "../app/runTradeConstruction.js";
import { SCAN_UNIVERSE_TIERS } from "../config/scanUniverseTiers.js";

export type AutomatedEntryScanCandidateAudit = {
  symbol: string | null;
  decision: string;
  reason: string | null;
  scan: ScanResult;
};

export type AutomatedEntryScanChunkSummary = {
  tier: string;
  label: string;
  from: number;
  to: number;
  symbols: string[];
  conclusion: ScanResult["conclusion"] | "trade_card_blocked";
  selectedSymbol: string | null;
  rankingScore: number | null;
  finalistCount: number;
  tradeCardReady: boolean;
  reason: string;
  durationMs: number;
};

export type AutomatedEntryConfirmedCandidate = {
  scan: ScanResult;
  telemetry: StarterUniverseTelemetry;
  tradeCard: TradeConstructionResult;
  rankingScore: number;
  chunkSummary: AutomatedEntryScanChunkSummary;
};

export type AutomatedEntryScanState = {
  version: 1;
  scanRunId: string;
  prompt: string;
  status: "running" | "completed";
  tierIndex: number;
  tierCursor: number;
  chunkCount: number;
  scannedSymbolCount: number;
  startedAt: string;
  excludedTickers: string[];
  paperLearningPreferences: ScanLearningPreference[];
  confirmedCandidates: AutomatedEntryConfirmedCandidate[];
  chunkSummaries: AutomatedEntryScanChunkSummary[];
  warnings: string[];
};

export type AutomatedEntryScanResult = {
  scanRunId: string;
  status: "running" | "completed";
  completed: boolean;
  scannedSymbolCount: number;
  totalSymbolCount: number;
  chunkCount: number;
  finalistCount: number;
  confirmedCandidates: AutomatedEntryConfirmedCandidate[];
  chunkSummaries: AutomatedEntryScanChunkSummary[];
  warnings: string[];
  state: AutomatedEntryScanState;
};

type AutomatedEntryScanParams = {
  scanRunId: string;
  prompt: string;
  excludedTickers: string[];
  tradestationBaseUrlOverride: string;
  paperLearningPreferences: ScanLearningPreference[];
  chunkSize?: number;
  timeBudgetMs?: number;
  state?: AutomatedEntryScanState | null;
  onCandidate?: (candidate: AutomatedEntryScanCandidateAudit) => Promise<void>;
};

const DEFAULT_AUTOMATED_SCAN_CHUNK_SIZE = 20;
const DEFAULT_AUTOMATED_SCAN_TIME_BUDGET_MS = 270_000;
const MAX_STORED_CHUNK_SUMMARIES = 120;

function normalizeSymbols(symbols: readonly string[]): string[] {
  return [...new Set(symbols.map((item) => item.toUpperCase()))].sort();
}

function readChunkSize(value: number | undefined): number {
  const envValue = process.env.AUTO_TRADER_SCAN_CHUNK_SIZE;
  const requestedValue =
    value ?? (
      envValue && envValue.trim().length > 0
        ? Number(envValue)
        : undefined
    );
  if (typeof requestedValue !== "number" || !Number.isFinite(requestedValue)) {
    return DEFAULT_AUTOMATED_SCAN_CHUNK_SIZE;
  }
  return Math.max(3, Math.min(20, Math.floor(requestedValue)));
}

function readTimeBudgetMs(value: number | undefined): number {
  const envValue = process.env.AUTO_TRADER_SCAN_TIME_BUDGET_MS;
  const requestedValue =
    value ?? (
      envValue && envValue.trim().length > 0
        ? Number(envValue)
        : undefined
    );
  if (typeof requestedValue !== "number" || !Number.isFinite(requestedValue)) {
    return DEFAULT_AUTOMATED_SCAN_TIME_BUDGET_MS;
  }
  return Math.max(15_000, Math.min(270_000, Math.floor(requestedValue)));
}

function totalSymbolCount(): number {
  return SCAN_UNIVERSE_TIERS.reduce((total, tier) => total + tier.symbols.length, 0);
}

function countSymbolsBeforeTier(tierIndex: number): number {
  return SCAN_UNIVERSE_TIERS
    .slice(0, tierIndex)
    .reduce((total, tier) => total + tier.symbols.length, 0);
}

function normalizeScanPosition(state: AutomatedEntryScanState): AutomatedEntryScanState {
  let tierIndex = Math.max(0, Math.floor(state.tierIndex));
  let tierCursor = Math.max(0, Math.floor(state.tierCursor));

  while (tierIndex < SCAN_UNIVERSE_TIERS.length) {
    const tier = SCAN_UNIVERSE_TIERS[tierIndex];
    if (!tier || tierCursor < tier.symbols.length) {
      break;
    }
    tierIndex += 1;
    tierCursor = 0;
  }

  const completed = tierIndex >= SCAN_UNIVERSE_TIERS.length;
  return {
    ...state,
    status: completed ? "completed" : state.status,
    tierIndex,
    tierCursor,
    scannedSymbolCount: completed
      ? totalSymbolCount()
      : countSymbolsBeforeTier(tierIndex) + tierCursor,
  };
}

function createInitialState(params: AutomatedEntryScanParams): AutomatedEntryScanState {
  return {
    version: 1,
    scanRunId: params.scanRunId,
    prompt: params.prompt,
    status: "running",
    tierIndex: 0,
    tierCursor: 0,
    chunkCount: 0,
    scannedSymbolCount: 0,
    startedAt: new Date().toISOString(),
    excludedTickers: normalizeSymbols(params.excludedTickers),
    paperLearningPreferences: params.paperLearningPreferences,
    confirmedCandidates: [],
    chunkSummaries: [],
    warnings: [],
  };
}

function canResumeState(
  state: AutomatedEntryScanState | null | undefined,
  params: AutomatedEntryScanParams,
): state is AutomatedEntryScanState {
  if (!state || state.version !== 1 || state.status !== "running") {
    return false;
  }
  if (state.prompt !== params.prompt) {
    return false;
  }
  const currentExcluded = normalizeSymbols(params.excludedTickers).join(",");
  return normalizeSymbols(state.excludedTickers).join(",") === currentExcluded;
}

function excludedBeforePosition(state: AutomatedEntryScanState): string[] {
  return [
    ...state.excludedTickers,
    ...SCAN_UNIVERSE_TIERS.slice(0, state.tierIndex).flatMap((tier) => tier.symbols),
    ...(SCAN_UNIVERSE_TIERS[state.tierIndex]?.symbols.slice(0, state.tierCursor) ?? []),
  ];
}

function readSelectedRankingScore(
  scan: ScanResult,
  telemetry: StarterUniverseTelemetry,
): number {
  const reviewed = telemetry.reviewedFinalistOutcomes ?? [];
  const selectedOutcome = reviewed.find((item) =>
    item.survivedFinalSelection || item.symbol === scan.ticker
  );
  if (typeof selectedOutcome?.rankingScore === "number") {
    return selectedOutcome.rankingScore;
  }

  const selectedRanking = (telemetry.finalRankingDebug ?? []).find((item) =>
    item.confirmedFinalSelection || item.symbol === scan.ticker
  );
  return typeof selectedRanking?.score === "number" ? selectedRanking.score : 0;
}

async function recordChunkCandidates(params: {
  scan: ScanResult;
  onCandidate?: (candidate: AutomatedEntryScanCandidateAudit) => Promise<void>;
}): Promise<number> {
  const { scan, onCandidate } = params;
  const ranking = scan.telemetry?.finalRankingDebug ?? [];
  if (!onCandidate || ranking.length === 0) {
    return ranking.length;
  }

  for (const item of ranking) {
    await onCandidate({
      symbol: item.symbol,
      decision: item.confirmedFinalSelection ? "scan_confirmed_candidate" : "scan_ranked_candidate",
      reason: item.reason,
      scan: {
        ...scan,
        ticker: item.symbol,
        direction: item.direction,
      },
    });
  }
  return ranking.length;
}

async function maybeBuildTradeCard(params: {
  scan: ScanResult;
  telemetry: StarterUniverseTelemetry;
  tradestationBaseUrlOverride: string;
}): Promise<TradeConstructionResult | null> {
  const { scan, telemetry, tradestationBaseUrlOverride } = params;
  if (
    scan.conclusion !== "confirmed" ||
    !scan.ticker ||
    !scan.direction ||
    !scan.confidence
  ) {
    return null;
  }

  const finalizedTradeGeometry = extractFinalizedTradeGeometryFromTelemetry(
    telemetry,
    scan.ticker,
  );
  return await constructTradeCard({
    prompt: `build trade ${scan.ticker}`,
    confirmedDirection: scan.direction,
    confirmedConfidence: scan.confidence,
    tradestationBaseUrlOverride,
    ...(finalizedTradeGeometry ? { finalizedTradeGeometry } : {}),
  });
}

async function advanceOneChunk(
  state: AutomatedEntryScanState,
  params: AutomatedEntryScanParams,
): Promise<AutomatedEntryScanState> {
  const normalized = normalizeScanPosition(state);
  if (normalized.status === "completed" || normalized.tierIndex >= SCAN_UNIVERSE_TIERS.length) {
    return normalizeScanPosition({
      ...normalized,
      status: "completed",
    });
  }

  const tier = SCAN_UNIVERSE_TIERS[normalized.tierIndex];
  if (!tier) {
    return normalizeScanPosition({
      ...normalized,
      status: "completed",
      tierIndex: SCAN_UNIVERSE_TIERS.length,
      tierCursor: 0,
    });
  }

  const chunkSize = Math.min(
    readChunkSize(params.chunkSize),
    tier.symbols.length - normalized.tierCursor,
  );
  const from = normalized.tierCursor;
  const to = Math.min(tier.symbols.length, from + chunkSize);
  const symbols = tier.symbols.slice(from, to);
  const startedAt = Date.now();
  const scanInput: ScanInput = {
    prompt: normalized.prompt,
    excludedTickers: excludedBeforePosition(normalized),
    tradestationBaseUrlOverride: params.tradestationBaseUrlOverride,
    paperLearningPreferences: normalized.paperLearningPreferences,
    scanTierLimit: normalized.tierIndex + 1,
    maxSymbolsPerTier: symbols.length,
  };
  const scan = await runScan(scanInput);
  const telemetry = scan.telemetry ?? null;
  if (!telemetry) {
    throw new Error("Automated entry scan did not receive TradeStation universe telemetry.");
  }

  const finalistCount = await recordChunkCandidates({
    scan,
    ...(params.onCandidate ? { onCandidate: params.onCandidate } : {}),
  });
  const rankingScore = readSelectedRankingScore(scan, telemetry);
  let tradeCard: TradeConstructionResult | null = null;
  let tradeCardError: string | null = null;
  try {
    tradeCard = await maybeBuildTradeCard({
      scan,
      telemetry,
      tradestationBaseUrlOverride: params.tradestationBaseUrlOverride,
    });
  } catch (error) {
    tradeCardError = error instanceof Error ? error.message : String(error);
  }

  const chunkSummary: AutomatedEntryScanChunkSummary = {
    tier: tier.key,
    label: tier.label,
    from: from + 1,
    to,
    symbols: [...symbols],
    conclusion: scan.conclusion === "confirmed" && !tradeCard
      ? "trade_card_blocked"
      : scan.conclusion,
    selectedSymbol: scan.ticker,
    rankingScore,
    finalistCount,
    tradeCardReady: tradeCard !== null,
    reason: tradeCardError ?? scan.reason,
    durationMs: Date.now() - startedAt,
  };
  const confirmedCandidates = tradeCard
    ? [
        ...normalized.confirmedCandidates,
        {
          scan,
          telemetry,
          tradeCard,
          rankingScore,
          chunkSummary,
        },
      ]
    : normalized.confirmedCandidates;

  return normalizeScanPosition({
    ...normalized,
    tierCursor: to,
    chunkCount: normalized.chunkCount + 1,
    confirmedCandidates,
    chunkSummaries: [...normalized.chunkSummaries, chunkSummary].slice(-MAX_STORED_CHUNK_SUMMARIES),
    warnings: [...normalized.warnings, ...(telemetry.consistencyChecks ?? [])].slice(-MAX_STORED_CHUNK_SUMMARIES),
  });
}

export async function runAutomatedEntryScan(
  params: AutomatedEntryScanParams,
): Promise<AutomatedEntryScanResult> {
  const timeBudgetMs = readTimeBudgetMs(params.timeBudgetMs);
  const startedAt = Date.now();
  const deadline = startedAt + timeBudgetMs;
  let state = normalizeScanPosition(
    canResumeState(params.state, params)
      ? params.state
      : createInitialState(params),
  );
  let processedChunks = 0;

  while (state.status === "running") {
    state = await advanceOneChunk(state, params);
    processedChunks += 1;
    if (state.status === "completed") {
      break;
    }
    if (processedChunks > 0 && Date.now() >= deadline) {
      break;
    }
  }

  const confirmedCandidates = [...state.confirmedCandidates].sort((left, right) =>
    right.rankingScore - left.rankingScore
  );
  const finalistCount = state.chunkSummaries.reduce(
    (total, chunk) => total + chunk.finalistCount,
    0,
  );
  const completed = state.status === "completed";

  return {
    scanRunId: state.scanRunId,
    status: state.status,
    completed,
    scannedSymbolCount: state.scannedSymbolCount,
    totalSymbolCount: totalSymbolCount(),
    chunkCount: state.chunkCount,
    finalistCount,
    confirmedCandidates,
    chunkSummaries: state.chunkSummaries,
    warnings: state.warnings,
    state,
  };
}
