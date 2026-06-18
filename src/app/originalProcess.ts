import { createOpenAiClient } from "../openai/client.js";
import { ALL_SCAN_UNIVERSE_SET, SCAN_UNIVERSE_TIERS, type ScanUniverseTierKey } from "../config/scanUniverseTiers.js";
import { DEFAULT_SCAN_PROMPT } from "../config/defaultScanPrompt.js";
import type { ScanConfidence, ScanDirection } from "../scanner/scoring.js";
import { createTradeStationGetFetcher } from "../tradestation/client.js";
import { createTradeRecommendation } from "../recommendations/repository.js";
import {
  buildMultiTimeframeBarsFromLoadedBars,
  normalizeBar,
  parseBars,
  runScan,
  runSingleSymbolTradeStationAnalysis,
  type MultiTimeframeBars,
  type MultiTimeframeView,
  type ScanResult,
  type StarterUniverseTelemetry,
} from "./runScan.js";
import { buildWorkflowPresentationSummary } from "./resultPresentation.js";
import {
  constructTradeCard,
  type FinalizedTradeGeometry,
  type TradeConstructionInput,
  type TradeConstructionResult,
} from "./runTradeConstruction.js";

const ORIGINAL_PROCESS_MODEL_ENV = "ORIGINAL_PROCESS_MODEL";
const ORIGINAL_PROCESS_CHUNK_SIZE_ENV = "ORIGINAL_PROCESS_CHUNK_SIZE";
const DEFAULT_ORIGINAL_PROCESS_MODEL = "gpt-4.1-mini";
const DEFAULT_ORIGINAL_PROCESS_CHUNK_SIZE = 8;
const DAILY_BARS_BACK = 160;
const WEEKLY_BARS_BACK = 60;
const PROMPT_MARKET_ROW_LIMIT = 180;

export const ORIGINAL_PROCESS_PROMPT_STAGES = {
  scan: `Run a new Scan for this week. Here’s what that means: Scan the broader U.S. options market (price $10–$500, avg volume >1M, tight option spreads, OI >500). Look for clean candlestick + volume structures: breakout/expansion candle, bullish/bearish engulfing, hammer/shooting star, morning/evening star. Prefer impulse + consolidation setups: a strong expansion candle on rising volume, followed by tight candles holding near highs/lows on reduced volume (no immediate give-back). New: Quality checks to avoid “fake holds” (distribution) For bullish setups, the consolidation must show supportive structure: Prefer flat-to-higher lows and flat highs (flag) or a tight range. Downgrade confidence if consolidation prints 2+ lower highs OR multiple red closes that drift toward the bottom of the range (stair-step down). Downgrade confidence if pullback candles are bigger-bodied than the prior consolidation candles or if wicks/bodies get “messy” at the hold zone. Volume behavior must match continuation: Prefer decreasing volume during consolidation. Downgrade confidence if selling candles expand in body size AND volume during the pullback (distribution signal). New: Resistance / “room to 2R” check Identify the nearest obvious overhead resistance (prior swing high / repeated rejection zone) on higher timeframes. Downgrade confidence if price is entering directly into resistance (little clean space for a 2R continuation). Prefer either: (A) A base that breaks into open space, OR (B) A breakout that closes above resistance and holds (no immediate close-back-inside the range). New: Failed-breakout / bull-trap filter Downgrade confidence if the most recent action shows: wick above a key level then close back below, especially if followed by red continuation candles. Avoid messy candles: excessive long wicks / choppy overlap at the trigger zone. Favor 14–21 DTE opportunities that allow a clean 2 : 1 structure once analyzed. Rotate sectors; repeat tickers only if it’s a fresh breakout/reversal zone. Exclude names with earnings inside the chosen DTE window. Output rules Return exactly one ticker for an immediate-entry options trade today. State: Direction (bullish/bearish) + Confidence band (65–74 / 75–84 / 85–92 / 93–97). If you can’t justify ≥65%, say “No trade today” and why. Do not give entry/strikes yet—only: “I think [TICKER] shows a (bullish/bearish) setup worth trading today (≈ __% confidence).”`,
  confirmation: `Here are the candlestick + volume charts for [TICKER] on multiple timeframes (1D, 1W, 1M, 3M, 1Y) and the options chain. Please analyze these charts based purely on candlestick + volume structure to confirm or reject your earlier recommendation. In your analysis: – Evaluate reversal/continuation strength using candle bodies, wicks, and volume confirmation. – Check alignment across timeframes (e.g., daily and weekly both showing the same momentum bias). – Identify whether the chart naturally supports our 2 : 1 risk-to-reward system (clean entry, logical stop, clear 2R target zone). – Conclude with one of the following: ✅ Confirmed — pattern + volume support a 2 : 1 trade and you hold ≥ 75 % confidence in the direction. ⚠️ Rejected — structure invalid or inconsistent volume. ❌ No trade today — cannot justify ≥ 65 % confidence. Do not provide entry, strike, or target details yet—wait until I request the full 2 : 1 setup after confirmation.`,
  tradeCard: `Based on your confirmed candlestick + volume analysis for [TICKER] and the options chain above, please build the complete trade setup using our 2 : 1 risk-to-reward rules. My total account equity is $x, but I’m allocating $0.3x exclusively to this trade. Use the entire allocation to calculate contract count and exposure (not just 3–5% risk). When you return the trade, present it in this structured, concise format (no paragraphs): Ticker: [TICKER] Direction: [Bullish / Bearish] Confidence: [65–74 % / 75–84 % / 85–92 % / 93–97 %] Buy: [Option expiration, strike, type] — Buy X contracts (using up to $trade allocation) Invalidation Exit: Exit if stock closes below/above [price]; show approximate option value at that level. Take-Profit Exit: Take profits if stock touches [target price]; show expected option value and % gain there. Time Exit: Exit if stock hasn’t hit invalidation or target by the Thursday before expiration (state the exact date), or if option value is >25 % below entry due to theta decay. R:R Math: List $ risk / $ reward / option % move (e.g., “Risk ≈ $20 per contract / Reward ≈ $40 / +160 % : −80 %”). Rationale: One sentence combining candlestick + volume logic (e.g., “Bullish engulfing on rising volume off support; strong follow-through candle confirms momentum”). Keep this exact structure so the trade card is immediately executable and can be pasted into my tracking sheet.`,
} as const;

export type OriginalProcessMarketRow = {
  symbol: string;
  tier: ScanUniverseTierKey;
  tierLabel: string;
  direction: ScanDirection | null;
  confidence: ScanConfidence | null;
  conclusion: ScanResult["conclusion"] | "candidate";
  rankingScore: number | null;
  lastPrice: number | null;
  averageVolume: number | null;
  targetExpiration: string | null;
  targetDte: number | null;
  optionOpenInterest: number | null;
  optionSpread: number | null;
  optionMid: number | null;
  movePct: number | null;
  volumeRatio: number | null;
  chartReviewScore: number | null;
  chartSummary: string | null;
  structureChecks: string | null;
  rewardRiskRatio: number | null;
  invalidationLevel: number | null;
  targetLevel: number | null;
  reason: string;
};

export type OriginalProcessChunkSummary = {
  tier: ScanUniverseTierKey;
  tierLabel: string;
  from: number;
  to: number;
  symbols: string[];
  selectedSymbol: string | null;
  conclusion: ScanResult["conclusion"];
  candidateRows: number;
  reason: string;
  durationMs: number;
};

export type OriginalProcessState = {
  version: 1;
  scanRunId: string;
  status: "running";
  tierIndex: number;
  tierCursor: number;
  chunkCount: number;
  scannedSymbolCount: number;
  startedAt: string;
  marketRows: OriginalProcessMarketRow[];
  chunkSummaries: OriginalProcessChunkSummary[];
  latestDataHealth: StarterUniverseTelemetry["dataHealth"] | null;
};

export type OriginalProcessProgress = {
  text: string;
  tier: string | null;
  scannedSymbolCount: number;
  totalSymbolCount: number;
  chunkCount: number;
  candidateRowCount: number;
};

export type OriginalProcessAiSelection =
  | {
      status: "selected";
      ticker: string;
      direction: ScanDirection;
      confidencePercent: number;
      confidence: ScanConfidence;
      reason: string;
    }
  | {
      status: "no_trade";
      ticker: null;
      direction: null;
      confidencePercent: null;
      confidence: null;
      reason: string;
    };

export type OriginalProcessAiConfirmation =
  | {
      status: "confirmed";
      direction: ScanDirection;
      confidencePercent: number;
      confidence: ScanConfidence;
      reason: string;
    }
  | {
      status: "rejected" | "no_trade";
      direction: ScanDirection | null;
      confidencePercent: number | null;
      confidence: ScanConfidence | null;
      reason: string;
    };

export type OriginalProcessSelectedContext = {
  ticker: string;
  timeframes: {
    label: MultiTimeframeView;
    barCount: number;
    latestClose: number | null;
    movePct: number | null;
    volumeRatio: number | null;
    latestBars: Record<string, unknown>[];
  }[];
  loadError: string | null;
};

export type OriginalProcessCompletedResponse = {
  status: "completed";
  scan_run_id: string;
  prompt: string;
  progress: OriginalProcessProgress;
  scan: ScanResult;
  tradeCard: TradeConstructionResult | null;
  journalPlannedTrade?: TradeConstructionResult["plannedJournalFields"];
  tradeRecommendation: unknown;
  telemetry: StarterUniverseTelemetry | null;
  presentationSummary: ReturnType<typeof buildWorkflowPresentationSummary>;
  originalProcess: {
    promptStages: typeof ORIGINAL_PROCESS_PROMPT_STAGES;
    scannedSymbolCount: number;
    totalSymbolCount: number;
    chunkCount: number;
    marketRows: OriginalProcessMarketRow[];
    selection: OriginalProcessAiSelection | null;
    confirmation: OriginalProcessAiConfirmation | null;
    selectedContext: OriginalProcessSelectedContext | null;
    serverValidationReason: string | null;
  };
};

export type OriginalProcessRunningResponse = {
  status: "running";
  scan_run_id: string;
  prompt: string;
  progress: OriginalProcessProgress;
  state: OriginalProcessState;
  latestChunk: OriginalProcessChunkSummary | null;
  originalProcess: {
    promptStages: typeof ORIGINAL_PROCESS_PROMPT_STAGES;
  };
};

export type OriginalProcessResponse =
  | OriginalProcessRunningResponse
  | OriginalProcessCompletedResponse;

type OpenAiClientLike = {
  responses: {
    create: (request: { model: string; input: string }) => Promise<{ output_text?: string }>;
  };
};

export type OriginalProcessDependencies = {
  createOpenAiClient?: () => Promise<OpenAiClientLike>;
  runScan?: (input: {
    prompt: string;
    excludedTickers?: string[];
    scanTierLimit?: number;
    maxSymbolsPerTier?: number;
  }) => Promise<ScanResult>;
  runSingleSymbolTradeStationAnalysis?: (
    symbol: string,
  ) => Promise<ScanResult & { confirmationDebug?: { finalizedTradeGeometry: FinalizedTradeGeometry | null } }>;
  constructTradeCard?: (input: TradeConstructionInput) => Promise<TradeConstructionResult>;
  createTradeRecommendation?: typeof createTradeRecommendation;
  loadSelectedContext?: (ticker: string) => Promise<OriginalProcessSelectedContext>;
};

type OriginalProcessRequestBody = {
  state?: unknown;
};

function totalSymbolCount(): number {
  return SCAN_UNIVERSE_TIERS.reduce((total, tier) => total + tier.symbols.length, 0);
}

function scanUniverseLabel(): string {
  return `${totalSymbolCount()} configured symbols across ${SCAN_UNIVERSE_TIERS.map((tier) => tier.label).join(", ")}`;
}

function buildScanRunId(): string {
  return `original_process_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function readChunkSize(): number {
  const parsed = Number(process.env[ORIGINAL_PROCESS_CHUNK_SIZE_ENV] ?? DEFAULT_ORIGINAL_PROCESS_CHUNK_SIZE);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_ORIGINAL_PROCESS_CHUNK_SIZE;
  }
  return Math.max(3, Math.min(20, Math.floor(parsed)));
}

function readModel(): string {
  return process.env[ORIGINAL_PROCESS_MODEL_ENV]?.trim() || DEFAULT_ORIGINAL_PROCESS_MODEL;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundNumber(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(digits));
}

function normalizeDirection(value: unknown): ScanDirection | null {
  const raw = readString(value)?.toLowerCase();
  if (raw === "bullish" || raw === "call" || raw === "calls") {
    return "bullish";
  }
  if (raw === "bearish" || raw === "put" || raw === "puts") {
    return "bearish";
  }
  return null;
}

function normalizeConfidenceBand(value: unknown): ScanConfidence | null {
  const raw = readString(value)?.replace(/\s+/g, "");
  if (raw === "65-74" || raw === "75-84" || raw === "85-92" || raw === "93-97") {
    return raw;
  }
  return null;
}

export function confidenceBandFromPercent(percent: number | null): ScanConfidence | null {
  if (percent === null || !Number.isFinite(percent)) {
    return null;
  }
  if (percent >= 93) {
    return "93-97";
  }
  if (percent >= 85) {
    return "85-92";
  }
  if (percent >= 75) {
    return "75-84";
  }
  if (percent >= 65) {
    return "65-74";
  }
  return null;
}

function readConfidence(value: Record<string, unknown>): { percent: number | null; band: ScanConfidence | null } {
  const percent = readNumberValue(
    value.confidencePercent ?? value.confidence_percent ?? value.confidence ?? value.percent,
  );
  const explicitBand = normalizeConfidenceBand(
    value.confidenceBand ?? value.confidence_band ?? value.confidenceBucket ?? value.confidence_bucket,
  );
  return {
    percent,
    band: explicitBand ?? confidenceBandFromPercent(percent),
  };
}

function isNoTradeTicker(value: unknown): boolean {
  const raw = readString(value)?.toLowerCase();
  return !raw || raw === "no trade today" || raw === "no_trade_today" || raw === "none" || raw === "null";
}

export function parseAiJson(outputText: string): Record<string, unknown> {
  const trimmed = outputText.trim();
  const direct = tryParseJsonObject(trimmed);
  if (direct) {
    return direct;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const extracted = tryParseJsonObject(trimmed.slice(start, end + 1));
    if (extracted) {
      return extracted;
    }
  }

  throw new Error("AI response must contain one valid JSON object.");
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

export function validateAiSelectionOutput(
  output: Record<string, unknown>,
  marketRows: OriginalProcessMarketRow[],
): OriginalProcessAiSelection {
  const status = readString(output.status)?.toLowerCase();
  const tickerRaw = output.ticker ?? output.symbol;
  const reason = readString(output.reason ?? output.rationale ?? output.explanation) ?? "No reason provided.";

  if (status === "no_trade" || status === "no_trade_today" || isNoTradeTicker(tickerRaw)) {
    return {
      status: "no_trade",
      ticker: null,
      direction: null,
      confidencePercent: null,
      confidence: null,
      reason,
    };
  }

  const ticker = readString(tickerRaw)?.toUpperCase() ?? null;
  if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) {
    throw new Error("AI selection must include a valid uppercase ticker.");
  }
  if (!ALL_SCAN_UNIVERSE_SET.has(ticker)) {
    throw new Error(`AI selected ${ticker}, which is outside the configured scan universe.`);
  }
  if (!marketRows.some((row) => row.symbol === ticker)) {
    throw new Error(`AI selected ${ticker}, but it was not present in the compact candidate packet.`);
  }

  const direction = normalizeDirection(output.direction);
  if (!direction) {
    throw new Error(`AI selection for ${ticker} must include bullish or bearish direction.`);
  }

  const { percent, band } = readConfidence(output);
  if (percent === null || percent < 65 || !band) {
    throw new Error(`AI selection for ${ticker} must have confidence >= 65%.`);
  }

  return {
    status: "selected",
    ticker,
    direction,
    confidencePercent: Math.round(percent),
    confidence: band,
    reason,
  };
}

export function validateAiConfirmationOutput(
  output: Record<string, unknown>,
): OriginalProcessAiConfirmation {
  const rawConclusion = readString(output.conclusion ?? output.status)?.toLowerCase().replace(/\s+/g, "_");
  const reason = readString(output.reason ?? output.rationale ?? output.explanation) ?? "No reason provided.";
  const direction = normalizeDirection(output.direction);
  const { percent, band } = readConfidence(output);

  if (rawConclusion === "confirmed") {
    if (!direction) {
      throw new Error("AI confirmation must include bullish or bearish direction.");
    }
    if (percent === null || percent < 75 || !band || band === "65-74") {
      throw new Error("AI confirmation requires confidence >= 75%.");
    }
    return {
      status: "confirmed",
      direction,
      confidencePercent: Math.round(percent),
      confidence: band,
      reason,
    };
  }

  if (rawConclusion === "rejected") {
    return {
      status: "rejected",
      direction,
      confidencePercent: percent === null ? null : Math.round(percent),
      confidence: band,
      reason,
    };
  }

  if (rawConclusion === "no_trade" || rawConclusion === "no_trade_today") {
    return {
      status: "no_trade",
      direction,
      confidencePercent: percent === null ? null : Math.round(percent),
      confidence: band,
      reason,
    };
  }

  throw new Error("AI confirmation must conclude confirmed, rejected, or no_trade_today.");
}

function buildInitialState(): OriginalProcessState {
  return {
    version: 1,
    scanRunId: buildScanRunId(),
    status: "running",
    tierIndex: 0,
    tierCursor: 0,
    chunkCount: 0,
    scannedSymbolCount: 0,
    startedAt: new Date().toISOString(),
    marketRows: [],
    chunkSummaries: [],
    latestDataHealth: null,
  };
}

function normalizeState(value: unknown): OriginalProcessState {
  const record = asRecord(value);
  if (!record || record.version !== 1 || readString(record.scanRunId) === null) {
    return buildInitialState();
  }

  const marketRows = Array.isArray(record.marketRows)
    ? record.marketRows.filter((row): row is OriginalProcessMarketRow => {
        const rowRecord = asRecord(row);
        return !!rowRecord && typeof rowRecord.symbol === "string";
      })
    : [];
  const chunkSummaries = Array.isArray(record.chunkSummaries)
    ? record.chunkSummaries.filter((summary): summary is OriginalProcessChunkSummary => !!asRecord(summary))
    : [];

  return {
    version: 1,
    scanRunId: readString(record.scanRunId) ?? buildScanRunId(),
    status: "running",
    tierIndex: Math.max(0, Math.floor(readNumberValue(record.tierIndex) ?? 0)),
    tierCursor: Math.max(0, Math.floor(readNumberValue(record.tierCursor) ?? 0)),
    chunkCount: Math.max(0, Math.floor(readNumberValue(record.chunkCount) ?? 0)),
    scannedSymbolCount: Math.max(0, Math.floor(readNumberValue(record.scannedSymbolCount) ?? 0)),
    startedAt: readString(record.startedAt) ?? new Date().toISOString(),
    marketRows,
    chunkSummaries,
    latestDataHealth: asRecord(record.latestDataHealth) as StarterUniverseTelemetry["dataHealth"] | null,
  };
}

function buildExcludedTickers(tierIndex: number, tierCursor: number): string[] {
  const priorTierSymbols = SCAN_UNIVERSE_TIERS
    .slice(0, tierIndex)
    .flatMap((tier) => tier.symbols);
  const tier = SCAN_UNIVERSE_TIERS[tierIndex];
  const priorChunkSymbols = tier ? tier.symbols.slice(0, tierCursor) : [];
  return [...priorTierSymbols, ...priorChunkSymbols];
}

function mergeRows(
  existing: OriginalProcessMarketRow[],
  incoming: OriginalProcessMarketRow[],
): OriginalProcessMarketRow[] {
  const bySymbol = new Map(existing.map((row) => [row.symbol, row]));
  for (const row of incoming) {
    const prior = bySymbol.get(row.symbol);
    if (!prior || rowScore(row) >= rowScore(prior)) {
      bySymbol.set(row.symbol, row);
    }
  }
  return sortMarketRows([...bySymbol.values()]);
}

function rowScore(row: OriginalProcessMarketRow): number {
  return (
    (row.rankingScore ?? -100) +
    (row.chartReviewScore ?? 0) +
    (row.rewardRiskRatio ?? 0) +
    (row.conclusion === "confirmed" ? 20 : 0)
  );
}

function sortMarketRows(rows: OriginalProcessMarketRow[]): OriginalProcessMarketRow[] {
  return [...rows].sort((left, right) => {
    const scoreDelta = rowScore(right) - rowScore(left);
    return scoreDelta !== 0 ? scoreDelta : left.symbol.localeCompare(right.symbol);
  });
}

function readFinalistBySymbol(
  telemetry: StarterUniverseTelemetry,
): Map<string, StarterUniverseTelemetry["reviewedFinalistOutcomes"][number]> {
  return new Map(telemetry.reviewedFinalistOutcomes.map((item) => [item.symbol, item]));
}

function buildRowFromReviewedOutcome(
  outcome: StarterUniverseTelemetry["reviewedFinalistOutcomes"][number],
  ranking: StarterUniverseTelemetry["finalRankingDebug"][number] | null,
  detail: StarterUniverseTelemetry["stage3PassedDetails"][number] | null,
  tier: ScanUniverseTierKey,
  tierLabel: string,
): OriginalProcessMarketRow {
  return {
    symbol: outcome.symbol,
    tier,
    tierLabel,
    direction: outcome.direction,
    confidence: outcome.confidence,
    conclusion: outcome.conclusion,
    rankingScore: roundNumber(outcome.rankingScore),
    lastPrice: null,
    averageVolume: null,
    targetExpiration: null,
    targetDte: null,
    optionOpenInterest: ranking?.scoreInputs.optionOpenInterest ?? null,
    optionSpread: roundNumber(ranking?.scoreInputs.optionSpread ?? null),
    optionMid: roundNumber(ranking?.scoreInputs.optionMid ?? null),
    movePct: roundNumber(ranking?.scoreInputs.movePct ?? null),
    volumeRatio: roundNumber(ranking?.scoreInputs.volumeRatio ?? null),
    chartReviewScore: roundNumber(ranking?.scoreInputs.chartReviewScore ?? null),
    chartSummary: detail?.summary ?? ranking?.reason ?? null,
    structureChecks: detail?.whyPassed ?? null,
    rewardRiskRatio: roundNumber(
      outcome.asymmetryDebug?.finalizedTradeRewardRiskRatio ??
      outcome.asymmetryDebug?.postConfirmationActualRewardRiskRatio ??
      outcome.asymmetryDebug?.preReviewActualRewardRiskRatio ??
      null,
    ),
    invalidationLevel: roundNumber(
      outcome.asymmetryDebug?.finalizedTradeInvalidationLevel ??
      outcome.asymmetryDebug?.postConfirmationInvalLevel ??
      outcome.asymmetryDebug?.preReviewInvalLevel ??
      null,
    ),
    targetLevel: roundNumber(
      outcome.asymmetryDebug?.finalizedTradeTargetLevel ??
      outcome.asymmetryDebug?.postConfirmationTargetLevel ??
      outcome.asymmetryDebug?.preReviewTargetLevel ??
      null,
    ),
    reason: outcome.reason,
  };
}

function buildRowFromRankingEntry(
  ranking: StarterUniverseTelemetry["finalRankingDebug"][number],
  detail: StarterUniverseTelemetry["stage3PassedDetails"][number] | null,
  tier: ScanUniverseTierKey,
  tierLabel: string,
): OriginalProcessMarketRow {
  return {
    symbol: ranking.symbol,
    tier,
    tierLabel,
    direction: ranking.direction,
    confidence: null,
    conclusion: "candidate",
    rankingScore: roundNumber(ranking.score),
    lastPrice: null,
    averageVolume: null,
    targetExpiration: null,
    targetDte: null,
    optionOpenInterest: ranking.scoreInputs.optionOpenInterest,
    optionSpread: roundNumber(ranking.scoreInputs.optionSpread),
    optionMid: roundNumber(ranking.scoreInputs.optionMid),
    movePct: roundNumber(ranking.scoreInputs.movePct),
    volumeRatio: roundNumber(ranking.scoreInputs.volumeRatio),
    chartReviewScore: roundNumber(ranking.scoreInputs.chartReviewScore),
    chartSummary: detail?.summary ?? ranking.reason,
    structureChecks: detail?.whyPassed ?? null,
    rewardRiskRatio: null,
    invalidationLevel: null,
    targetLevel: null,
    reason: ranking.reason,
  };
}

export function buildMarketRowsFromTelemetry(
  telemetry: StarterUniverseTelemetry | null | undefined,
  tier: ScanUniverseTierKey,
  tierLabel: string,
): OriginalProcessMarketRow[] {
  if (!telemetry) {
    return [];
  }

  const rows: OriginalProcessMarketRow[] = [];
  const reviewedBySymbol = readFinalistBySymbol(telemetry);
  const rankingBySymbol = new Map(telemetry.finalRankingDebug.map((item) => [item.symbol, item]));
  const detailBySymbol = new Map(telemetry.stage3PassedDetails.map((item) => [item.symbol, item]));
  for (const outcome of telemetry.reviewedFinalistOutcomes) {
    rows.push(
      buildRowFromReviewedOutcome(
        outcome,
        rankingBySymbol.get(outcome.symbol) ?? null,
        detailBySymbol.get(outcome.symbol) ?? null,
        tier,
        tierLabel,
      ),
    );
  }

  for (const ranking of telemetry.finalRankingDebug) {
    if (reviewedBySymbol.has(ranking.symbol)) {
      continue;
    }
    rows.push(buildRowFromRankingEntry(ranking, detailBySymbol.get(ranking.symbol) ?? null, tier, tierLabel));
  }

  for (const detail of telemetry.stage3PassedDetails) {
    if (rows.some((row) => row.symbol === detail.symbol)) {
      continue;
    }
    rows.push({
      symbol: detail.symbol,
      tier,
      tierLabel,
      direction: detail.direction,
      confidence: null,
      conclusion: "candidate",
      rankingScore: roundNumber(detail.score),
      lastPrice: null,
      averageVolume: null,
      targetExpiration: null,
      targetDte: null,
      optionOpenInterest: null,
      optionSpread: null,
      optionMid: null,
      movePct: null,
      volumeRatio: null,
      chartReviewScore: roundNumber(detail.score),
      chartSummary: detail.summary,
      structureChecks: detail.whyPassed,
      rewardRiskRatio: null,
      invalidationLevel: null,
      targetLevel: null,
      reason: detail.whyPassed,
    });
  }

  return sortMarketRows(rows);
}

async function advanceScanState(
  state: OriginalProcessState,
  deps: OriginalProcessDependencies,
): Promise<OriginalProcessState> {
  const tier = SCAN_UNIVERSE_TIERS[state.tierIndex];
  if (!tier) {
    return state;
  }

  const chunkSize = Math.min(readChunkSize(), tier.symbols.length - state.tierCursor);
  if (chunkSize <= 0) {
    return {
      ...state,
      tierIndex: state.tierIndex + 1,
      tierCursor: 0,
    };
  }

  const from = state.tierCursor;
  const to = Math.min(tier.symbols.length, from + chunkSize);
  const chunkSymbols = tier.symbols.slice(from, to);
  const startedAt = Date.now();
  const runScanImpl = deps.runScan ?? runScan;
  const scan = await runScanImpl({
    prompt: DEFAULT_SCAN_PROMPT,
    excludedTickers: buildExcludedTickers(state.tierIndex, state.tierCursor),
    scanTierLimit: state.tierIndex + 1,
    maxSymbolsPerTier: chunkSize,
  });
  const durationMs = Date.now() - startedAt;
  const telemetry = scan.telemetry ?? null;
  const rows = buildMarketRowsFromTelemetry(telemetry, tier.key, tier.label);
  const nextCursor = to >= tier.symbols.length ? 0 : to;
  const nextTierIndex = to >= tier.symbols.length ? state.tierIndex + 1 : state.tierIndex;

  const chunkSummary: OriginalProcessChunkSummary = {
    tier: tier.key,
    tierLabel: tier.label,
    from,
    to,
    symbols: [...chunkSymbols],
    selectedSymbol: scan.ticker,
    conclusion: scan.conclusion,
    candidateRows: rows.length,
    reason: scan.reason,
    durationMs,
  };

  return {
    ...state,
    tierIndex: nextTierIndex,
    tierCursor: nextCursor,
    chunkCount: state.chunkCount + 1,
    scannedSymbolCount: state.scannedSymbolCount + chunkSymbols.length,
    marketRows: mergeRows(state.marketRows, rows),
    chunkSummaries: [...state.chunkSummaries, chunkSummary],
    latestDataHealth: telemetry?.dataHealth ?? state.latestDataHealth,
  };
}

function buildProgress(state: OriginalProcessState, text: string): OriginalProcessProgress {
  const tier = SCAN_UNIVERSE_TIERS[state.tierIndex] ?? null;
  return {
    text,
    tier: tier?.label ?? null,
    scannedSymbolCount: state.scannedSymbolCount,
    totalSymbolCount: totalSymbolCount(),
    chunkCount: state.chunkCount,
    candidateRowCount: state.marketRows.length,
  };
}

function compactRowsForPrompt(rows: OriginalProcessMarketRow[]): OriginalProcessMarketRow[] {
  return sortMarketRows(rows).slice(0, PROMPT_MARKET_ROW_LIMIT);
}

function buildSelectionPrompt(state: OriginalProcessState): string {
  return [
    "You are recreating the user's original ChatGPT scanning process using current API market data.",
    "Use the scan prompt exactly as the user's intent, but choose only from candidateMarketRows.",
    "If none justify at least 65% confidence, return no_trade_today.",
    "",
    `Original scan prompt:\n${ORIGINAL_PROCESS_PROMPT_STAGES.scan}`,
    "",
    "Return JSON only with exactly these keys:",
    '{ "status": "selected|no_trade_today", "ticker": "AAPL|null", "direction": "bullish|bearish|null", "confidencePercent": number|null, "confidenceBand": "65-74|75-84|85-92|93-97|null", "reason": "one concise reason" }',
    "",
    `Configured-universe scan summary: ${JSON.stringify({
      configuredSymbolCount: totalSymbolCount(),
      universe: scanUniverseLabel(),
      scannedSymbolCount: state.scannedSymbolCount,
      chunkCount: state.chunkCount,
      candidateRowCount: state.marketRows.length,
      latestDataHealth: state.latestDataHealth?.summary ?? null,
    })}`,
    "",
    `Candidate market rows: ${JSON.stringify(compactRowsForPrompt(state.marketRows))}`,
  ].join("\n");
}

function buildConfirmationPrompt(params: {
  selection: Extract<OriginalProcessAiSelection, { status: "selected" }>;
  selectedContext: OriginalProcessSelectedContext;
}): string {
  return [
    "You are continuing the user's original staged ChatGPT workflow.",
    "Confirm or reject the earlier ticker using only the supplied candlestick, volume, timeframe, and options-fit context.",
    "",
    `Original confirmation prompt:\n${ORIGINAL_PROCESS_PROMPT_STAGES.confirmation.replace("[TICKER]", params.selection.ticker)}`,
    "",
    "Return JSON only with exactly these keys:",
    '{ "conclusion": "confirmed|rejected|no_trade_today", "direction": "bullish|bearish|null", "confidencePercent": number|null, "confidenceBand": "75-84|85-92|93-97|null", "reason": "one concise reason" }',
    "",
    `Earlier recommendation: ${JSON.stringify(params.selection)}`,
    "",
    `Current multi-timeframe context: ${JSON.stringify(params.selectedContext)}`,
  ].join("\n");
}

async function runOpenAiJsonPrompt(prompt: string, deps: OriginalProcessDependencies): Promise<Record<string, unknown>> {
  const createClient = deps.createOpenAiClient ?? createOpenAiClient;
  const client = await createClient();
  const response = await client.responses.create({
    model: readModel(),
    input: prompt,
  });
  const outputText = typeof response.output_text === "string" ? response.output_text.trim() : "";
  if (!outputText) {
    throw new Error("AI returned no text.");
  }
  return parseAiJson(outputText);
}

async function chooseOriginalProcessTicker(
  state: OriginalProcessState,
  deps: OriginalProcessDependencies,
): Promise<OriginalProcessAiSelection> {
  const output = await runOpenAiJsonPrompt(buildSelectionPrompt(state), deps);
  return validateAiSelectionOutput(output, state.marketRows);
}

async function confirmOriginalProcessTicker(
  selection: Extract<OriginalProcessAiSelection, { status: "selected" }>,
  selectedContext: OriginalProcessSelectedContext,
  deps: OriginalProcessDependencies,
): Promise<OriginalProcessAiConfirmation> {
  const output = await runOpenAiJsonPrompt(buildConfirmationPrompt({ selection, selectedContext }), deps);
  return validateAiConfirmationOutput(output);
}

function readBarNumber(bar: Record<string, unknown> | null | undefined, keys: string[]): number | null {
  if (!bar) {
    return null;
  }
  for (const key of keys) {
    const parsed = readNumberValue(bar[key]);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function computeMovePct(bars: Record<string, unknown>[]): number | null {
  const firstClose = readBarNumber(bars[0], ["Close", "Last"]);
  const lastClose = readBarNumber(bars[bars.length - 1], ["Close", "Last"]);
  if (firstClose === null || lastClose === null || firstClose <= 0) {
    return null;
  }
  return roundNumber(((lastClose - firstClose) / firstClose) * 100);
}

function computeVolumeRatio(bars: Record<string, unknown>[]): number | null {
  const latest = bars[bars.length - 1];
  const latestVolume = readBarNumber(latest, ["Volume", "TotalVolume", "Vol", "TotalVolumeTraded"]);
  const priorVolumes = bars
    .slice(Math.max(0, bars.length - 21), -1)
    .map((bar) => readBarNumber(bar, ["Volume", "TotalVolume", "Vol", "TotalVolumeTraded"]))
    .filter((value): value is number => value !== null && value > 0);
  if (latestVolume === null || priorVolumes.length === 0) {
    return null;
  }
  const average = priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length;
  return average > 0 ? roundNumber(latestVolume / average) : null;
}

function summarizeBars(label: MultiTimeframeView, bars: Record<string, unknown>[]) {
  const latestClose = readBarNumber(bars[bars.length - 1], ["Close", "Last"]);
  return {
    label,
    barCount: bars.length,
    latestClose: roundNumber(latestClose),
    movePct: computeMovePct(bars),
    volumeRatio: label === "1D" ? computeVolumeRatio(bars) : null,
    latestBars: bars.slice(-8),
  };
}

export async function loadOriginalProcessSelectedContext(
  ticker: string,
): Promise<OriginalProcessSelectedContext> {
  try {
    const get = await createTradeStationGetFetcher();
    const [dailyResponse, weeklyResponse] = await Promise.all([
      get(`/marketdata/barcharts/${encodeURIComponent(ticker)}?interval=1&unit=Daily&barsback=${DAILY_BARS_BACK}`),
      get(`/marketdata/barcharts/${encodeURIComponent(ticker)}?interval=1&unit=Weekly&barsback=${WEEKLY_BARS_BACK}`),
    ]);
    if (!dailyResponse.ok || !weeklyResponse.ok) {
      return {
        ticker,
        timeframes: [],
        loadError: `Failed to load selected ticker bars (daily HTTP ${dailyResponse.status}, weekly HTTP ${weeklyResponse.status}).`,
      };
    }

    const dailyBars = parseBars(await dailyResponse.json()).map((bar) => normalizeBar(bar));
    const weeklyBars = parseBars(await weeklyResponse.json()).map((bar) => normalizeBar(bar));
    const barsByView: MultiTimeframeBars = buildMultiTimeframeBarsFromLoadedBars({
      dailyBars,
      weeklyBars,
    });

    return {
      ticker,
      timeframes: (["1D", "1W", "1M", "3M", "1Y"] as MultiTimeframeView[])
        .map((label) => summarizeBars(label, barsByView[label] ?? [])),
      loadError: null,
    };
  } catch (error) {
    return {
      ticker,
      timeframes: [],
      loadError: error instanceof Error ? error.message : "Failed to load selected ticker context.",
    };
  }
}

function buildCompletedNoTradeResponse(params: {
  state: OriginalProcessState;
  reason: string;
  selection: OriginalProcessAiSelection | null;
  confirmation: OriginalProcessAiConfirmation | null;
  selectedContext: OriginalProcessSelectedContext | null;
  serverValidationReason: string | null;
  ticker?: string | null;
  direction?: ScanDirection | null;
}): OriginalProcessCompletedResponse {
  const scan: ScanResult = {
    ticker: params.ticker ?? null,
    direction: params.direction ?? null,
    confidence: null,
    conclusion: "no_trade_today",
    reason: params.reason,
    telemetry: null,
  };
  const presentationSummary = buildWorkflowPresentationSummary({
    scan,
    telemetry: null,
    tradeCard: null,
  });

  return {
    status: "completed",
    scan_run_id: params.state.scanRunId,
    prompt: ORIGINAL_PROCESS_PROMPT_STAGES.scan,
    progress: buildProgress(params.state, "Original Process complete: no trade today."),
    scan,
    tradeCard: null,
    tradeRecommendation: null,
    telemetry: null,
    presentationSummary,
    originalProcess: {
      promptStages: ORIGINAL_PROCESS_PROMPT_STAGES,
      scannedSymbolCount: params.state.scannedSymbolCount,
      totalSymbolCount: totalSymbolCount(),
      chunkCount: params.state.chunkCount,
      marketRows: params.state.marketRows,
      selection: params.selection,
      confirmation: params.confirmation,
      selectedContext: params.selectedContext,
      serverValidationReason: params.serverValidationReason,
    },
  };
}

export function buildCompletedOriginalProcessTradeResponse(params: {
  state: OriginalProcessState;
  scan: ScanResult;
  tradeCard: TradeConstructionResult;
  selection: OriginalProcessAiSelection;
  confirmation: OriginalProcessAiConfirmation;
  selectedContext: OriginalProcessSelectedContext;
  tradeRecommendation?: unknown;
  serverValidationReason: string | null;
}): OriginalProcessCompletedResponse {
  const presentationSummary = buildWorkflowPresentationSummary({
    scan: params.scan,
    telemetry: null,
    tradeCard: params.tradeCard,
  });

  return {
    status: "completed",
    scan_run_id: params.state.scanRunId,
    prompt: ORIGINAL_PROCESS_PROMPT_STAGES.scan,
    progress: buildProgress(params.state, `Original Process complete: trade card ready for ${params.tradeCard.ticker}.`),
    scan: params.scan,
    tradeCard: params.tradeCard,
    journalPlannedTrade: params.tradeCard.plannedJournalFields,
    tradeRecommendation: params.tradeRecommendation ?? null,
    telemetry: null,
    presentationSummary,
    originalProcess: {
      promptStages: ORIGINAL_PROCESS_PROMPT_STAGES,
      scannedSymbolCount: params.state.scannedSymbolCount,
      totalSymbolCount: totalSymbolCount(),
      chunkCount: params.state.chunkCount,
      marketRows: params.state.marketRows,
      selection: params.selection,
      confirmation: params.confirmation,
      selectedContext: params.selectedContext,
      serverValidationReason: params.serverValidationReason,
    },
  };
}

async function finalizeOriginalProcess(
  state: OriginalProcessState,
  deps: OriginalProcessDependencies,
): Promise<OriginalProcessCompletedResponse> {
  if (state.marketRows.length === 0) {
    return buildCompletedNoTradeResponse({
      state,
      reason: `Configured-universe scan completed across ${scanUniverseLabel()}, but no compact candidate rows survived the market-data gates.`,
      selection: null,
      confirmation: null,
      selectedContext: null,
      serverValidationReason: null,
    });
  }

  const selection = await chooseOriginalProcessTicker(state, deps);
  if (selection.status === "no_trade") {
    return buildCompletedNoTradeResponse({
      state,
      reason: selection.reason,
      selection,
      confirmation: null,
      selectedContext: null,
      serverValidationReason: null,
    });
  }

  const loadSelectedContext = deps.loadSelectedContext ?? loadOriginalProcessSelectedContext;
  const selectedContext = await loadSelectedContext(selection.ticker);
  const confirmation = await confirmOriginalProcessTicker(selection, selectedContext, deps);
  if (confirmation.status !== "confirmed") {
    return buildCompletedNoTradeResponse({
      state,
      reason: confirmation.reason,
      selection,
      confirmation,
      selectedContext,
      serverValidationReason: null,
      ticker: selection.ticker,
      direction: selection.direction,
    });
  }

  const reviewSymbol = deps.runSingleSymbolTradeStationAnalysis ?? runSingleSymbolTradeStationAnalysis;
  const serverReview = await reviewSymbol(selection.ticker);
  if (
    serverReview.conclusion !== "confirmed" ||
    !serverReview.direction ||
    !serverReview.confidence
  ) {
    return buildCompletedNoTradeResponse({
      state,
      reason: `AI confirmed ${selection.ticker}, but server validation rejected the setup. ${serverReview.reason}`,
      selection,
      confirmation,
      selectedContext,
      serverValidationReason: serverReview.reason,
      ticker: selection.ticker,
      direction: selection.direction,
    });
  }

  if (serverReview.direction !== confirmation.direction) {
    return buildCompletedNoTradeResponse({
      state,
      reason: `AI confirmation direction (${confirmation.direction}) did not match server validation (${serverReview.direction}).`,
      selection,
      confirmation,
      selectedContext,
      serverValidationReason: serverReview.reason,
      ticker: selection.ticker,
      direction: selection.direction,
    });
  }

  try {
    const buildTradeCard = deps.constructTradeCard ?? constructTradeCard;
    const finalizedTradeGeometry = serverReview.confirmationDebug?.finalizedTradeGeometry ?? null;
    const tradeCard = await buildTradeCard({
      prompt: `build trade ${selection.ticker}`,
      confirmedDirection: serverReview.direction,
      confirmedConfidence: serverReview.confidence,
      ...(finalizedTradeGeometry ? { finalizedTradeGeometry } : {}),
    });
    const scan: ScanResult = {
      ticker: selection.ticker,
      direction: serverReview.direction,
      confidence: serverReview.confidence,
      conclusion: "confirmed",
      reason: `Original Process AI confirmed ${selection.ticker}: ${confirmation.reason} Server validation: ${serverReview.reason}`,
      telemetry: null,
    };
    let tradeRecommendation = null;
    const persistRecommendation = deps.createTradeRecommendation ?? createTradeRecommendation;
    try {
      tradeRecommendation = await persistRecommendation({
        scan_run_id: state.scanRunId,
        prompt: ORIGINAL_PROCESS_PROMPT_STAGES.scan,
        planned_trade: tradeCard.plannedJournalFields,
        signal_snapshot_json: {
          scan,
          tradeCard,
          originalProcess: {
            selection,
            confirmation,
            selectedContext,
            serverValidationReason: serverReview.reason,
          },
        },
      });
    } catch (error) {
      console.warn("Failed to persist Original Process trade recommendation history.", error);
    }

    return buildCompletedOriginalProcessTradeResponse({
      state,
      scan,
      tradeCard,
      selection,
      confirmation,
      selectedContext,
      tradeRecommendation,
      serverValidationReason: serverReview.reason,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trade-card construction failed.";
    return buildCompletedNoTradeResponse({
      state,
      reason: `AI confirmed ${selection.ticker}, but server-validated trade-card construction blocked it. ${message}`,
      selection,
      confirmation,
      selectedContext,
      serverValidationReason: serverReview.reason,
      ticker: selection.ticker,
      direction: serverReview.direction,
    });
  }
}

export async function runOriginalProcessStep(
  body: OriginalProcessRequestBody,
  deps: OriginalProcessDependencies = {},
): Promise<OriginalProcessResponse> {
  let state = normalizeState(body.state);

  while (state.tierIndex < SCAN_UNIVERSE_TIERS.length) {
    state = await advanceScanState(state, deps);
    if (state.tierIndex < SCAN_UNIVERSE_TIERS.length) {
      return {
        status: "running",
        scan_run_id: state.scanRunId,
        prompt: ORIGINAL_PROCESS_PROMPT_STAGES.scan,
        progress: buildProgress(state, `Original Process scanning configured universe: ${state.scannedSymbolCount}/${totalSymbolCount()} symbols screened across ${SCAN_UNIVERSE_TIERS.length} tier(s).`),
        state,
        latestChunk: state.chunkSummaries.at(-1) ?? null,
        originalProcess: {
          promptStages: ORIGINAL_PROCESS_PROMPT_STAGES,
        },
      };
    }
  }

  return await finalizeOriginalProcess(state, deps);
}
