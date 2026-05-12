import {
  extractFinalizedTradeGeometryFromTelemetry,
  runScan,
  type ScanLearningPreference,
  type ScanResult,
  type StarterUniverseTelemetry,
} from "../src/app/runScan.js";
import { buildWorkflowPresentationSummary } from "../src/app/resultPresentation.js";
import {
  constructTradeCard,
  type TradeConstructionResult,
} from "../src/app/runTradeConstruction.js";
import { DEFAULT_SCAN_PROMPT } from "../src/config/defaultScanPrompt.js";
import { SCAN_UNIVERSE_TIERS } from "../src/config/scanUniverseTiers.js";
import { listJournalTradeDetails } from "../src/journal/repository.js";
import { createTradeRecommendation } from "../src/recommendations/repository.js";
import { trainEntryRewardModel } from "../src/automation/entryRewardModel.js";
import { buildPaperLearningPreferences } from "../src/automation/paperLearningPreferences.js";

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
  scanRunId: string;
  prompt: string;
  status: "running" | "completed";
  tierIndex: number;
  tierCursor: number;
  chunkCount: number;
  scannedSymbolCount: number;
  startedAt: string;
  paperLearningPreferences: ScanLearningPreference[];
  bestConfirmed: ManualScanBest | null;
  chunkSummaries: ManualScanChunkSummary[];
  latestDataHealth: StarterUniverseTelemetry["dataHealth"] | null;
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
    learningPreferenceCount: number;
  };
};

type ManualScanProgress = {
  text: string;
  tier: string | null;
  scannedSymbolCount: number;
  totalSymbolCount: number;
  chunkCount: number;
  bestSymbol: string | null;
  learningPreferenceCount: number;
};

const DEFAULT_CHUNK_SIZE = 8;

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

function totalSymbolCount(): number {
  return SCAN_UNIVERSE_TIERS.reduce((total, tier) => total + tier.symbols.length, 0);
}

function countSymbolsBeforeTier(tierIndex: number): number {
  return SCAN_UNIVERSE_TIERS
    .slice(0, tierIndex)
    .reduce((total, tier) => total + tier.symbols.length, 0);
}

function readManualScanState(value: unknown): ManualScanState | null {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ManualScanState>
    : null;
  if (!record || typeof record.scanRunId !== "string" || typeof record.prompt !== "string") {
    return null;
  }

  return {
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
    paperLearningPreferences: Array.isArray(record.paperLearningPreferences)
      ? record.paperLearningPreferences as ScanLearningPreference[]
      : [],
    bestConfirmed: record.bestConfirmed ?? null,
    chunkSummaries: Array.isArray(record.chunkSummaries)
      ? record.chunkSummaries.slice(-80) as ManualScanChunkSummary[]
      : [],
    latestDataHealth: record.latestDataHealth ?? null,
    finalResponse: record.finalResponse ?? null,
  };
}

async function buildLearningPreferences(): Promise<ScanLearningPreference[]> {
  try {
    const trades = await listJournalTradeDetails(200, { accountMode: "paper" });
    return buildPaperLearningPreferences(trainEntryRewardModel(trades));
  } catch (error) {
    console.warn("Manual scan could not load paper-learning preferences.", error);
    return [];
  }
}

async function createInitialState(body: unknown): Promise<ManualScanState> {
  return {
    scanRunId: buildScanRunId(),
    prompt: readPrompt(body),
    status: "running",
    tierIndex: 0,
    tierCursor: 0,
    chunkCount: 0,
    scannedSymbolCount: 0,
    startedAt: new Date().toISOString(),
    paperLearningPreferences: await buildLearningPreferences(),
    bestConfirmed: null,
    chunkSummaries: [],
    latestDataHealth: null,
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
  return {
    text,
    tier: tier?.label ?? null,
    scannedSymbolCount: state.scannedSymbolCount,
    totalSymbolCount: totalSymbolCount(),
    chunkCount: state.chunkCount,
    bestSymbol: state.bestConfirmed?.scan.ticker ?? null,
    learningPreferenceCount: state.paperLearningPreferences.length,
  };
}

async function maybeBuildTradeCard(
  scan: ScanResult,
  telemetry: StarterUniverseTelemetry | null,
): Promise<TradeConstructionResult | null> {
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
    ...(finalizedTradeGeometry ? { finalizedTradeGeometry } : {}),
  });
}

async function finalizeState(state: ManualScanState): Promise<ManualScanState> {
  const best = state.bestConfirmed;
  const scannedText = `${totalSymbolCount()} symbols across Tier 1, Tier 2, and Tier 3`;

  if (!best) {
    const scan: ScanResult = {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: `Manual scan completed ${state.chunkCount} chunk(s) over ${scannedText}. No confirmed trade-card-ready setup survived the scanner, confirmation, and trade-card gates.`,
      telemetry: null,
    };
    const presentationSummary = buildWorkflowPresentationSummary({
      scan,
      telemetry: null,
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
      telemetry: null,
      presentationSummary,
      manualScan: {
        chunkCount: state.chunkCount,
        scannedSymbolCount: totalSymbolCount(),
        totalSymbolCount: totalSymbolCount(),
        bestSymbol: null,
        chunkSummaries: state.chunkSummaries,
        learningPreferenceCount: state.paperLearningPreferences.length,
      },
    };
    return {
      ...state,
      status: "completed",
      scannedSymbolCount: totalSymbolCount(),
      finalResponse,
    };
  }

  const scan: ScanResult = {
    ...best.scan,
    reason: `Selected ${best.scan.ticker} as the best confirmed setup after scanning ${scannedText}. ${best.scan.reason}`,
  };
  const presentationSummary = buildWorkflowPresentationSummary({
    scan,
    telemetry: best.telemetry,
    tradeCard: best.tradeCard,
  });
  const signalSnapshotJson = {
    scan,
    telemetry: best.telemetry,
    tradeCard: best.tradeCard,
    presentationSummary,
    manualScan: {
      chunkCount: state.chunkCount,
      chunkSummaries: state.chunkSummaries,
      learningPreferenceCount: state.paperLearningPreferences.length,
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
    telemetry: best.telemetry,
    presentationSummary,
    manualScan: {
      chunkCount: state.chunkCount,
      scannedSymbolCount: totalSymbolCount(),
      totalSymbolCount: totalSymbolCount(),
      bestSymbol: scan.ticker,
      chunkSummaries: state.chunkSummaries,
      learningPreferenceCount: state.paperLearningPreferences.length,
    },
  };

  return {
    ...state,
    status: "completed",
    scannedSymbolCount: totalSymbolCount(),
    finalResponse,
  };
}

async function advanceState(initialState: ManualScanState): Promise<ManualScanState> {
  const state = normalizeScanPosition(initialState);
  if (state.status === "completed") {
    return state;
  }
  if (state.tierIndex >= SCAN_UNIVERSE_TIERS.length) {
    return await finalizeState(state);
  }

  const tier = SCAN_UNIVERSE_TIERS[state.tierIndex];
  if (!tier) {
    return await finalizeState({
      ...state,
      tierIndex: SCAN_UNIVERSE_TIERS.length,
    });
  }
  const chunkSize = Math.min(readChunkSize(), tier.symbols.length - state.tierCursor);
  const from = state.tierCursor;
  const to = Math.min(tier.symbols.length, from + chunkSize);
  const chunkSymbols = tier.symbols.slice(from, to);
  const startedAt = Date.now();
  const scan = await runScan({
    prompt: state.prompt,
    excludedTickers: buildExcludedTickers(state.tierIndex, state.tierCursor),
    scanTierLimit: state.tierIndex + 1,
    maxSymbolsPerTier: chunkSize,
    paperLearningPreferences: state.paperLearningPreferences,
  });
  if (!scan.telemetry) {
    throw new Error("Manual scan did not receive TradeStation universe telemetry; market data was unavailable for this chunk.");
  }
  const telemetry = scan.telemetry ?? null;
  const rankingScore = readSelectedRankingScore(scan, telemetry);
  let tradeCard: TradeConstructionResult | null = null;
  let tradeCardBlockReason: string | null = null;

  try {
    tradeCard = await maybeBuildTradeCard(scan, telemetry);
  } catch (error) {
    tradeCardBlockReason = readErrorMessage(error);
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
    tradeCard && (!state.bestConfirmed || candidateScore > state.bestConfirmed.score)
      ? {
          score: candidateScore,
          scan,
          telemetry,
          tradeCard,
          chunkSummary,
        }
      : state.bestConfirmed;
  const nextState = normalizeScanPosition({
    ...state,
    tierCursor: to,
    chunkCount: state.chunkCount + 1,
    bestConfirmed,
    chunkSummaries: [...state.chunkSummaries, chunkSummary].slice(-80),
    latestDataHealth: telemetry?.dataHealth ?? state.latestDataHealth,
  });

  if (nextState.tierIndex >= SCAN_UNIVERSE_TIERS.length) {
    return await finalizeState(nextState);
  }

  return nextState;
}

function buildRunningResponse(state: ManualScanState): Record<string, unknown> {
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
