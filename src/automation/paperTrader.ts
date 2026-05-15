import { buildWorkflowPresentationSummary } from "../app/resultPresentation.js";
import { MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO } from "../app/chartAnchoredTradability.js";
import { runScan } from "../app/runScan.js";
import type { TradeConstructionResult } from "../app/runTradeConstruction.js";
import {
  archiveJournalTradeWithoutReview,
  closeJournalTrade,
  createJournalTrade,
  listJournalTradeDetails,
  updateJournalTrade,
  updateJournalTradeSignalSnapshot,
} from "../journal/repository.js";
import type { JournalTradeDetail } from "../journal/types.js";
import {
  assertPaperTraderConfig,
  isTradeStationSimBaseUrl,
  readPaperTraderConfig,
  type PaperTraderConfig,
} from "./config.js";
import {
  decideAiManagementAction,
  enforceAiManagementGuardrails,
} from "./aiManager.js";
import {
  runAutomatedEntryScan,
  type AutomatedEntryScanState,
} from "./automatedEntryScan.js";
import {
  recommendPolicyAction,
  trainPolicyModel,
} from "./policyModel.js";
import {
  buildEntryRewardFeatureInput,
  buildEntryRewardFeatureSnapshot,
  recommendEntryPolicy,
  summarizeEntryRewardModel,
  trainEntryRewardModel,
  type EntryPolicyRecommendation,
  type EntryRewardFeatureInput,
} from "./entryRewardModel.js";
import { buildPaperLearningPreferences } from "./paperLearningPreferences.js";
import {
  listRecentPaperEntryCandidates,
  recordPaperEntryCandidate,
  type PaperEntryCandidateRecord,
} from "./entryCandidateHistory.js";
import {
  createAutomationTradeStationClient,
  extractAverageFillPrice,
  extractPositionSnapshots,
  findPositionSnapshot,
  normalizeTradeStationOrderPrice,
  summarizeExecutions,
  type AutomationTradeStationClient,
  type TradeStationOrderRequest,
  type TradeStationOrderResult,
  type TradeStationPositionSnapshot,
} from "./tradestation.js";
import {
  loadLatestPaperTraderRunWithRaw,
  listRecentPaperTraderRuns,
  recordPaperTraderRun,
  type PaperTraderRunRecord,
} from "./paperTraderHistory.js";

const MAX_TRADESTATION_CONTRACTS_PER_ORDER = 2000;
// Paper entries are daily/weekly continuation trades, not penny-distance scalps.
const MIN_AUTOMATED_ENTRY_TARGET_ROOM_PCT = 0.0075;
const MIN_AUTOMATED_ENTRY_RISK_ROOM_PCT = 0.0025;
const MAX_AUTOMATED_SCAN_RESUME_AGE_MS = 6 * 60 * 60 * 1000;

type PaperTraderRunOptions = {
  prompt?: string;
  dryRun?: boolean;
  source?: "api" | "cli";
  reconcileOnly?: boolean;
  reconcileOrders?: boolean;
  skipNewEntry?: boolean;
  includeHistory?: boolean;
};

type ChicagoClockParts = {
  date: string;
  time: string;
  weekday: string;
  hour: number;
  minute: number;
};

type AutomationSnapshot = {
  automation?: {
    lane?: string;
    paperTrader?: {
      accountId?: string;
      optionSymbol?: string;
      quantity?: number;
      requestedQuantity?: number;
      filledQuantity?: number;
      remainingQuantity?: number;
      entryOrderType?: "Limit";
      entryTradeAction?: "BUYTOOPEN";
      entryLimitPrice?: number;
      entryAverageFillPrice?: number | null;
      entryFillStatus?: "unfilled" | "partial" | "filled" | "unknown";
      intendedStopUnderlying?: number;
      intendedTargetUnderlying?: number;
      activeStopUnderlying?: number;
      activeTargetUnderlying?: number;
      timeExitDate?: string;
      orderId?: string | null;
      lastOrderStatus?: string | null;
      lastOrderCheckAt?: string;
      lastOrderCheckError?: string | null;
      lastPositionQuantity?: number | null;
      managementStyle?: "ai";
      lastManagementAction?: "hold" | "update_levels" | "exit_now" | "fallback";
      lastManagementConfidence?: "low" | "medium" | "high";
      lastManagementNote?: string;
      lastManagementThesis?: string;
      lastManagementAt?: string;
      managementHistory?: PaperTraderManagementHistoryEntry[];
      decisionLog?: PaperTraderDecisionLogEntry[];
      entryReasoning?: PaperTraderEntryReasoning;
      accountValueAtEntry?: number | null;
      maxPositionPct?: number;
      maxPositionCostUsd?: number | null;
      positionPctAtEntry?: number | null;
    };
  };
};

type PaperTraderManagementHistoryEntry = {
  timestamp: string;
  action: "hold" | "update_levels" | "exit_now" | "fallback";
  confidence?: "low" | "medium" | "high";
  stopUnderlying?: number | null;
  targetUnderlying?: number | null;
  currentUnderlyingPrice?: number | null;
  currentOptionMid?: number | null;
  progressToTargetPct?: number | null;
  optionReturnPct?: number | null;
  note: string;
  thesis?: string | null;
  rewardR?: number | null;
};

type PaperTraderDecisionLogEntry = {
  timestamp: string;
  tradeId?: string | null;
  symbol: string | null;
  kind: "entry" | "management" | "exit" | "order_check";
  action: string;
  outcome?: string | null;
  confidence?: "low" | "medium" | "high" | null;
  reason?: string | null;
  note: string;
  thesis?: string | null;
  plainEnglishExplanation?: string | null;
  optionSymbol?: string | null;
  orderId?: string | null;
  quantity?: number | null;
  positionCostUsd?: number | null;
  accountValueUsd?: number | null;
  maxPositionCostUsd?: number | null;
  positionPct?: number | null;
  stopUnderlying?: number | null;
  targetUnderlying?: number | null;
  currentUnderlyingPrice?: number | null;
  currentOptionMid?: number | null;
  reasoning?: PaperTraderEntryReasoning | null;
  entryPolicy?: EntryPolicyRecommendation | null;
};

type PaperTraderTradeHistoryItem = {
  tradeId: string;
  symbol: string;
  status: JournalTradeDetail["status"];
  direction: JournalTradeDetail["direction"];
  entryDate: string;
  entryTime: string | null;
  expirationDate: string | null;
  contracts: number | null;
  positionCostUsd: number | null;
  entryOptionPrice: number | null;
  entryUnderlyingPrice: number | null;
  activeStopUnderlying: number | null;
  activeTargetUnderlying: number | null;
  optionSymbol: string | null;
  orderId: string | null;
  fillStatus: string | null;
  filledQuantity: number | null;
  remainingQuantity: number | null;
  lastOrderCheckAt: string | null;
  lastManagementAction: string | null;
  lastManagementAt: string | null;
  lastManagementNote: string | null;
  latestExitReason: string | null;
  realizedPlUsd: number | null;
  realizedRMultiple: number | null;
  decisionLog: PaperTraderDecisionLogEntry[];
  managementHistory: PaperTraderManagementHistoryEntry[];
};

type PaperTraderAutomationSnapshot = NonNullable<
  NonNullable<AutomationSnapshot["automation"]>["paperTrader"]
>;

type ExitDecision = {
  reason: "target_hit" | "stop_hit" | "time_exit" | "manual_early_exit";
  note: string;
};

type EntryPolicyEffectivenessBucket = {
  policyDecision: string;
  evaluatedCandidates: number;
  enteredCandidates: number;
  closedTrades: number;
  policyBlockedCandidates: number;
  averageRealizedR: number | null;
  winRate: number | null;
  averagePolicyPriorR: number | null;
  averageActualMinusPolicyR: number | null;
};

type EntryPolicyEffectivenessSummary = {
  evaluatedCandidates: number;
  candidatesWithPolicy: number;
  enteredCandidates: number;
  closedCandidates: number;
  policyBlockedCandidates: number;
  shadowTrackedCandidates: number;
  buckets: EntryPolicyEffectivenessBucket[];
  summary: string;
};

export type PaperTraderStatus = {
  enabled: boolean;
  allowOrderPlacement: boolean;
  liveRunReady: boolean;
  automationBaseUrl: string;
  accountIdConfigured: boolean;
  maxOpenTrades: number | null;
  maxDailyLossUsd: number | null;
  maxPositionPct: number;
  requiresSecret: boolean;
  openPaperTrades: number;
  liveSimPositions: number | null;
  staleOpenJournalTrades: number | null;
  sizing: {
    accountValueUsd: number | null;
    unrealizedPlUsd: number | null;
    equitiesBuyingPowerUsd: number | null;
    optionsBuyingPowerUsd: number | null;
    maxPositionCostUsd: number | null;
    openPositionCount: number | null;
    openContractCount: number | null;
    openPositionCostUsd: number | null;
    openPositionMarketValueUsd: number | null;
    positions: {
      symbol: string;
      quantity: number | null;
      averagePrice: number | null;
      marketValueUsd: number | null;
      unrealizedPlUsd: number | null;
      estimatedCostUsd: number | null;
    }[];
    error: string | null;
  };
  configurationIssues: string[];
  dataWarnings: string[];
  learning: {
    closedPaperTrades: number;
    managementExperiences: number;
    entryExperiences: number;
    entryLearnedContexts: number;
    learnedContexts: number;
    readyForPolicyPrior: boolean;
    entryFeatureCoverage: ReturnType<typeof trainEntryRewardModel>["featureCoverage"];
    entryPolicySummary: string | null;
    entryPolicyEffectiveness: EntryPolicyEffectivenessSummary;
  };
  recentDecisionLog: PaperTraderDecisionLogEntry[];
  paperTradeHistory: PaperTraderTradeHistoryItem[];
  entryCandidateHistory: PaperEntryCandidateRecord[];
  entryCandidateHistoryMigrationRequired: boolean;
  entryCandidateHistoryMigrationMessage: string | null;
  runHistory: PaperTraderRunRecord[];
  runHistoryMigrationRequired: boolean;
  runHistoryMigrationMessage: string | null;
};

type PaperTraderEntryReasoning = {
  conciseReasoning: string | null;
  whyThisWon: string | null;
  tradeRationale: string | null;
  optionChosen: string | null;
  chartGeometry: Record<string, unknown> | null;
};

type PaperTraderEntryCandidateEvaluation = {
  symbol: string | null;
  decision: string;
  reason: string;
  entryPolicy: EntryPolicyRecommendation | null;
  features: EntryRewardFeatureInput | null;
};

type PaperTraderRunResult = {
  mode: "paper";
  timestamp: string;
  dryRun: boolean;
  dryRunReason: string | null;
  config: {
    automationBaseUrl: string;
    allowOrderPlacement: boolean;
    accountId: string;
    maxOpenTrades: number | null;
    maxDailyLossUsd: number | null;
    maxPositionPct: number;
  };
  guards: {
    openPaperTrades: number;
    liveSimPositions: number | null;
    staleOpenJournalTrades: number | null;
    todayRealizedPlUsd: number;
    newEntriesAllowed: boolean;
  };
  reconciliation: {
    inspected: number;
    updated: number;
    partialFills: number;
    staleArchived: number;
    adoptedPositions: number;
    updates: {
      tradeId: string;
      symbol: string;
      orderId: string | null;
      fillStatus: string;
      filledQuantity: number | null;
      requestedQuantity: number | null;
      remainingQuantity: number | null;
      averageFillPrice: number | null;
      note: string;
      archived?: boolean;
    }[];
    skipped: {
      tradeId: string;
      symbol: string;
      reason: string;
    }[];
  };
  management: {
    inspected: number;
    updates: {
      tradeId: string;
      symbol: string;
      action: "ai_hold" | "ai_update_levels" | "ai_exit_now" | "ai_fallback";
      stopUnderlying: number | null;
      targetUnderlying: number | null;
      note: string;
    }[];
    exitsTriggered: {
      tradeId: string;
      symbol: string;
      reason: ExitDecision["reason"];
      action: "closed" | "would_close" | "skipped";
      orderId: string | null;
      optionExitPrice: number | null;
      note: string;
    }[];
    skipped: {
      tradeId: string;
      symbol: string;
      reason: string;
    }[];
  };
  entry: {
    attempted: boolean;
    outcome:
      | "outside_market_hours"
      | "skipped_after_guard"
      | "no_trade_today"
      | "scan_in_progress"
      | "trade_card_blocked"
      | "zero_contract_trade"
      | "preview_only"
      | "entered_paper_trade"
      | "monitor_only";
    symbol: string | null;
    reason: string;
    orderId?: string | null;
    journalTradeId?: string | null;
    tradeCard?: TradeConstructionResult | null;
    reasoning?: PaperTraderEntryReasoning;
    evaluatedCandidates?: PaperTraderEntryCandidateEvaluation[];
    scanSummary?: {
      status: "running" | "completed";
      scannedSymbolCount: number;
      totalSymbolCount: number;
      chunkCount: number;
      finalistCount: number;
      confirmedCandidateCount: number;
      mlAdjustmentSummary: string[];
    };
    automatedScanState?: AutomatedEntryScanState | null;
  };
  decisionLog: PaperTraderDecisionLogEntry[];
  paperTradeHistory: PaperTraderTradeHistoryItem[];
  entryCandidateHistory: PaperEntryCandidateRecord[];
  entryCandidateHistoryMigrationRequired: boolean;
  entryCandidateHistoryMigrationMessage: string | null;
  runHistory: PaperTraderRunRecord[];
  runHistoryMigrationRequired: boolean;
  runHistoryMigrationMessage: string | null;
};

type PaperTraderRunResultCore = Omit<
  PaperTraderRunResult,
  | "decisionLog"
  | "paperTradeHistory"
  | "entryCandidateHistory"
  | "entryCandidateHistoryMigrationRequired"
  | "entryCandidateHistoryMigrationMessage"
  | "runHistory"
  | "runHistoryMigrationRequired"
  | "runHistoryMigrationMessage"
>;

function readNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function validateEntryGeometry(tradeCard: TradeConstructionResult): string | null {
  const fields = tradeCard.plannedJournalFields;
  const entry = readNumber(fields.underlying_entry_price);
  const stop = readNumber(fields.intended_stop_underlying);
  const target = readNumber(fields.intended_target_underlying);

  if (entry === null || stop === null || target === null) {
    return "Trade card is missing entry, stop, or target geometry.";
  }
  if (entry <= 0) {
    return `Trade card has invalid entry geometry: entry ${entry.toFixed(2)} must be positive.`;
  }

  if (fields.direction === "CALL") {
    if (stop >= entry) {
      return `Bullish CALL geometry is invalid: entry ${entry.toFixed(2)} must be above stop ${stop.toFixed(2)}.`;
    }
    if (target <= entry) {
      return `Bullish CALL geometry is invalid: target ${target.toFixed(2)} must be above entry ${entry.toFixed(2)}.`;
    }
  } else {
    if (stop <= entry) {
      return `Bearish PUT geometry is invalid: entry ${entry.toFixed(2)} must be below stop ${stop.toFixed(2)}.`;
    }
    if (target >= entry) {
      return `Bearish PUT geometry is invalid: target ${target.toFixed(2)} must be below entry ${entry.toFixed(2)}.`;
    }
  }

  const isCall = fields.direction === "CALL";
  const directionLabel = isCall ? "Bullish CALL" : "Bearish PUT";
  const riskDistance = isCall ? entry - stop : stop - entry;
  const rewardDistance = isCall ? target - entry : entry - target;
  const riskPct = riskDistance / entry;
  const rewardPct = rewardDistance / entry;
  const rewardRiskRatio = rewardDistance / riskDistance;

  if (rewardPct < MIN_AUTOMATED_ENTRY_TARGET_ROOM_PCT) {
    return `${directionLabel} geometry is too tight for automation: target room is ${formatPct(rewardPct)} from entry (${entry.toFixed(2)} -> ${target.toFixed(2)}), below the ${formatPct(MIN_AUTOMATED_ENTRY_TARGET_ROOM_PCT)} minimum.`;
  }
  if (riskPct < MIN_AUTOMATED_ENTRY_RISK_ROOM_PCT) {
    return `${directionLabel} geometry is too tight for automation: stop distance is ${formatPct(riskPct)} from entry (${entry.toFixed(2)} -> ${stop.toFixed(2)}), below the ${formatPct(MIN_AUTOMATED_ENTRY_RISK_ROOM_PCT)} minimum.`;
  }
  if (rewardRiskRatio < MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO) {
    return `${directionLabel} geometry is invalid at the live entry: reward/risk ${rewardRiskRatio.toFixed(2)}R is below the ${MINIMUM_CONFIRMABLE_RISK_REWARD_RATIO.toFixed(2)}R minimum confirmable threshold.`;
  }

  return null;
}

function formatChicagoParts(date = new Date()): ChicagoClockParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
    weekday: values.weekday ?? "Mon",
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function toChicagoDateString(isoTimestamp: string): string {
  return formatChicagoParts(new Date(isoTimestamp)).date;
}

function isRegularUsEquitySession(date = new Date()): boolean {
  const chicago = formatChicagoParts(date);
  if (chicago.weekday === "Sat" || chicago.weekday === "Sun") {
    return false;
  }

  const minutes = (chicago.hour * 60) + chicago.minute;
  return minutes >= (8 * 60) + 30 && minutes < 15 * 60;
}

function buildPaperTraderConfigurationIssues(config: PaperTraderConfig): string[] {
  const issues: string[] = [];

  if (!config.allowOrderPlacement) {
    issues.push(
      "Set AUTO_TRADER_ALLOW_ORDER_PLACEMENT=1 to allow live SIM order placement; requests stay preview-only until then.",
    );
  }

  if (!config.accountId) {
    issues.push("Set TRADESTATION_AUTOMATION_ACCOUNT_ID to the dedicated SIM paper account id.");
  }

  if (!isTradeStationSimBaseUrl(config.automationBaseUrl)) {
    issues.push(
      "Set TRADESTATION_AUTOMATION_BASE_URL=https://sim-api.tradestation.com/v3 for the paper trader.",
    );
  }

  if (config.allowOrderPlacement && !config.apiSecret) {
    issues.push("Set AUTO_TRADER_API_SECRET or CRON_SECRET before enabling live SIM order placement.");
  }

  return issues;
}

function buildEntryReasoning(
  scan: Awaited<ReturnType<typeof runScan>>,
  tradeCard: TradeConstructionResult | null,
): PaperTraderEntryReasoning {
  const presentationSummary = buildWorkflowPresentationSummary({
    scan,
    telemetry: scan.telemetry ?? null,
    tradeCard,
  });

  return {
    conciseReasoning: presentationSummary.conciseReasoning,
    whyThisWon: presentationSummary.whyThisWon,
    tradeRationale: tradeCard?.rationale ?? null,
    optionChosen: presentationSummary.tradeCard?.optionChosen ?? null,
    chartGeometry: presentationSummary.finalChartGeometry,
  };
}

function buildScanRunId(): string {
  return `paper_scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function mlActionFromEntryPolicy(
  entryPolicy: EntryPolicyRecommendation | null | undefined,
): string | null {
  if (!entryPolicy) {
    return null;
  }
  if (entryPolicy.decision === "block") {
    return "hard_block";
  }
  if (entryPolicy.decision === "caution") {
    return "penalty";
  }
  if (entryPolicy.decision === "favor") {
    return "boost";
  }
  return entryPolicy.sampleSize > 0 && entryPolicy.sampleSize < 8
    ? "shadow"
    : "allow";
}

function mlScoreAdjustmentFromEntryPolicy(
  entryPolicy: EntryPolicyRecommendation | null | undefined,
): number | null {
  if (!entryPolicy) {
    return null;
  }
  if (entryPolicy.decision === "block") {
    return -8;
  }
  if (entryPolicy.decision === "caution") {
    return Math.min(-1, Math.max(-3, entryPolicy.averageRewardR ?? -1));
  }
  if (entryPolicy.decision === "favor") {
    return Math.max(1, Math.min(3, entryPolicy.averageRewardR ?? 1));
  }
  return 0;
}

async function recordEntryCandidateAudit(input: {
  scanRunId: string;
  dryRun: boolean;
  symbol: string | null;
  decision: string;
  decisionReason: string | null;
  paperTradeId?: string | null;
  orderId?: string | null;
  features?: EntryRewardFeatureInput | null;
  entryPolicy?: EntryPolicyRecommendation | null;
  selected?: boolean;
  scan?: unknown;
  tradeCard?: unknown;
}): Promise<void> {
  try {
    await recordPaperEntryCandidate({
      scanRunId: input.scanRunId,
      dryRun: input.dryRun,
      symbol: input.symbol,
      decision: input.decision,
      decisionReason: input.decisionReason,
      paperTradeId: input.paperTradeId ?? null,
      orderId: input.orderId ?? null,
      features: input.features ?? null,
      entryPolicy: input.entryPolicy ?? null,
      mlAction: mlActionFromEntryPolicy(input.entryPolicy),
      mlScoreAdjustment: mlScoreAdjustmentFromEntryPolicy(input.entryPolicy),
      selected: input.selected ?? false,
      scan: asRecord(input.scan) ?? null,
      tradeCard: asRecord(input.tradeCard) ?? null,
    });
  } catch (error) {
    console.warn(
      "paper entry candidate audit write failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function readAutomationSnapshot(
  trade: JournalTradeDetail,
): PaperTraderAutomationSnapshot | null {
  const snapshot = trade.signal_snapshot_json as AutomationSnapshot | null;
  return snapshot?.automation?.paperTrader ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readAutomatedScanStateFromLatestRun(
  run: PaperTraderRunRecord | null,
): AutomatedEntryScanState | null {
  if (!run || run.outcome !== "scan_in_progress") {
    return null;
  }
  const createdAtMs = Date.parse(run.created_at);
  if (
    !Number.isFinite(createdAtMs)
    || Date.now() - createdAtMs > MAX_AUTOMATED_SCAN_RESUME_AGE_MS
  ) {
    return null;
  }

  const raw = asRecord(run.raw_result_json);
  const entry = asRecord(raw?.entry);
  const state = asRecord(entry?.automatedScanState);
  if (
    state?.version !== 1 ||
    state.status !== "running" ||
    typeof state.scanRunId !== "string" ||
    typeof state.prompt !== "string"
  ) {
    return null;
  }

  return state as AutomatedEntryScanState;
}

async function loadResumableAutomatedScanState(
  dryRun: boolean,
): Promise<AutomatedEntryScanState | null> {
  try {
    const latestRun = await loadLatestPaperTraderRunWithRaw({ dryRun });
    return readAutomatedScanStateFromLatestRun(latestRun);
  } catch (error) {
    console.warn(
      "paper trader could not load resumable automated scan state",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function buildUpdatedSignalSnapshot(
  trade: JournalTradeDetail,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const currentSnapshot = asRecord(trade.signal_snapshot_json) ?? {};
  const automation = asRecord(currentSnapshot.automation) ?? {};
  const paperTrader = asRecord(automation.paperTrader) ?? {};

  return {
    ...currentSnapshot,
    automation: {
      ...automation,
      paperTrader: {
        ...paperTrader,
        ...updates,
      },
    },
  };
}

function readManagementHistory(
  automation: PaperTraderAutomationSnapshot | null,
): PaperTraderManagementHistoryEntry[] {
  return Array.isArray(automation?.managementHistory)
    ? automation.managementHistory.filter((item): item is PaperTraderManagementHistoryEntry =>
        !!item
        && typeof item === "object"
        && typeof (item as { timestamp?: unknown }).timestamp === "string"
        && typeof (item as { action?: unknown }).action === "string"
        && typeof (item as { note?: unknown }).note === "string"
      )
    : [];
}

function appendManagementHistory(
  existing: PaperTraderManagementHistoryEntry[],
  entry: PaperTraderManagementHistoryEntry,
): PaperTraderManagementHistoryEntry[] {
  return [...existing, entry].slice(-30);
}

function readDecisionLog(
  automation: PaperTraderAutomationSnapshot | null,
): PaperTraderDecisionLogEntry[] {
  return Array.isArray(automation?.decisionLog)
    ? automation.decisionLog.filter((item): item is PaperTraderDecisionLogEntry =>
        !!item
        && typeof item === "object"
        && typeof (item as { timestamp?: unknown }).timestamp === "string"
        && typeof (item as { kind?: unknown }).kind === "string"
        && typeof (item as { action?: unknown }).action === "string"
        && typeof (item as { note?: unknown }).note === "string"
      )
    : [];
}

function appendDecisionLog(
  existing: PaperTraderDecisionLogEntry[],
  entry: PaperTraderDecisionLogEntry,
): PaperTraderDecisionLogEntry[] {
  return [...existing, entry].slice(-50);
}

function collectRecentDecisionLog(
  trades: JournalTradeDetail[],
  limit = 500,
): PaperTraderDecisionLogEntry[] {
  return trades
    .flatMap((trade) => {
      const automation = readAutomationSnapshot(trade);
      return readDecisionLog(automation).map((entry) => ({
        ...entry,
        tradeId: entry.tradeId ?? trade.id,
        symbol: entry.symbol ?? trade.symbol,
      }));
    })
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit);
}

function buildPaperTradeHistory(
  trades: JournalTradeDetail[],
): PaperTraderTradeHistoryItem[] {
  return trades
    .filter((trade) => trade.account_mode === "paper")
    .map((trade) => {
      const automation = readAutomationSnapshot(trade);
      const activeLevels = automation
        ? readActiveManagementLevels(trade, automation)
        : {
            stopUnderlying: readNumber(trade.intended_stop_underlying),
            targetUnderlying: readNumber(trade.intended_target_underlying),
          };

      return {
        tradeId: trade.id,
        symbol: trade.symbol,
        status: trade.status,
        direction: trade.direction,
        entryDate: trade.entry_date,
        entryTime: trade.entry_time,
        expirationDate: trade.expiration_date,
        contracts: trade.contracts,
        positionCostUsd: readNumber(trade.position_cost_usd),
        entryOptionPrice: readNumber(trade.option_entry_price),
        entryUnderlyingPrice: readNumber(trade.underlying_entry_price),
        activeStopUnderlying: activeLevels.stopUnderlying,
        activeTargetUnderlying: activeLevels.targetUnderlying,
        optionSymbol: automation?.optionSymbol ?? null,
        orderId: automation?.orderId ?? null,
        fillStatus: automation?.entryFillStatus ?? automation?.lastOrderStatus ?? null,
        filledQuantity: automation?.filledQuantity ?? null,
        remainingQuantity: automation?.remainingQuantity ?? null,
        lastOrderCheckAt: automation?.lastOrderCheckAt ?? null,
        lastManagementAction: automation?.lastManagementAction ?? null,
        lastManagementAt: automation?.lastManagementAt ?? null,
        lastManagementNote: automation?.lastManagementNote ?? null,
        latestExitReason: trade.latest_exit?.exit_reason ?? null,
        realizedPlUsd: readNumber(trade.review?.realized_pl_usd ?? null),
        realizedRMultiple: readNumber(trade.review?.realized_r_multiple ?? null),
        decisionLog: readDecisionLog(automation),
        managementHistory: readManagementHistory(automation),
      };
    });
}

function formatNonCriticalHistoryError(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("PGRST002")
    || message.includes("57014")
    || message.toLowerCase().includes("statement timeout")
    || message.toLowerCase().includes("request timed out")
    || message.includes("schema cache")
    || message.includes("Supabase select failed (503)")
  ) {
    return `${label} is temporarily unavailable while Supabase catches up. Try Load Status again in a minute.`;
  }

  return `${label} is temporarily unavailable: ${message}`;
}

async function loadJournalTradesForPaperTraderStatus(): Promise<{
  trades: JournalTradeDetail[];
  warning: string | null;
}> {
  try {
    return {
      trades: await listJournalTradeDetails(250, {
        accountMode: "paper",
        includeSignalSnapshot: true,
      }),
      warning: null,
    };
  } catch (error) {
    return {
      trades: [],
      warning: formatNonCriticalHistoryError("Compact journal dashboard rows", error),
    };
  }
}

async function loadPaperTraderCycleTrades(): Promise<JournalTradeDetail[]> {
  const [openTrades, closedTrades] = await Promise.all([
    listJournalTradeDetails(50, {
      accountMode: "paper",
      status: "open",
      includeSignalSnapshot: true,
    }),
    listJournalTradeDetails(300, {
      accountMode: "paper",
      status: "closed",
      includeSignalSnapshot: true,
    }),
  ]);
  return [...openTrades, ...closedTrades];
}

async function loadPaperTraderRunHistory(): Promise<{
  runHistory: PaperTraderRunRecord[];
  runHistoryMigrationRequired: boolean;
  runHistoryMigrationMessage: string | null;
}> {
  try {
    const runHistoryResult = await listRecentPaperTraderRuns(50);
    return {
      runHistory: runHistoryResult.runs,
      runHistoryMigrationRequired: runHistoryResult.migrationRequired,
      runHistoryMigrationMessage: runHistoryResult.migrationMessage,
    };
  } catch (error) {
    return {
      runHistory: [],
      runHistoryMigrationRequired: false,
      runHistoryMigrationMessage: formatNonCriticalHistoryError(
        "Paper trader run history",
        error,
      ),
    };
  }
}

async function loadPaperEntryCandidateHistory(limit = 50): Promise<{
  entryCandidateHistory: PaperEntryCandidateRecord[];
  entryCandidateHistoryMigrationRequired: boolean;
  entryCandidateHistoryMigrationMessage: string | null;
}> {
  try {
    const result = await listRecentPaperEntryCandidates(limit);
    return {
      entryCandidateHistory: result.candidates,
      entryCandidateHistoryMigrationRequired: result.migrationRequired,
      entryCandidateHistoryMigrationMessage: result.migrationMessage,
    };
  } catch (error) {
    return {
      entryCandidateHistory: [],
      entryCandidateHistoryMigrationRequired: false,
      entryCandidateHistoryMigrationMessage: formatNonCriticalHistoryError(
        "Entry candidate audit",
        error,
      ),
    };
  }
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

function buildEntryPolicyEffectivenessSummary(
  trades: JournalTradeDetail[],
  candidates: PaperEntryCandidateRecord[],
): EntryPolicyEffectivenessSummary {
  const tradeById = new Map(trades.map((trade) => [trade.id, trade]));
  const candidatesWithPolicy = candidates.filter((candidate) => candidate.entry_policy_decision);
  const buckets = new Map<string, {
    candidates: PaperEntryCandidateRecord[];
    realizedR: number[];
    policyPriorR: number[];
  }>();

  for (const candidate of candidatesWithPolicy) {
    const policyDecision = candidate.entry_policy_decision ?? "unknown";
    const bucket = buckets.get(policyDecision) ?? {
      candidates: [],
      realizedR: [],
      policyPriorR: [],
    };
    bucket.candidates.push(candidate);

    const priorR = readNumber(candidate.entry_policy_average_reward_r);
    if (priorR !== null) {
      bucket.policyPriorR.push(priorR);
    }

    const linkedTrade = candidate.paper_trade_id
      ? tradeById.get(candidate.paper_trade_id)
      : null;
    const realizedR = readNumber(linkedTrade?.review?.realized_r_multiple ?? null);
    if (
      linkedTrade?.account_mode === "paper"
      && linkedTrade.status === "closed"
      && realizedR !== null
    ) {
      bucket.realizedR.push(realizedR);
    }

    buckets.set(policyDecision, bucket);
  }

  const bucketSummaries = Array.from(buckets.entries())
    .map(([policyDecision, bucket]) => {
      const enteredCandidates = bucket.candidates.filter((candidate) => candidate.paper_trade_id).length;
      const policyPriorAverage = average(bucket.policyPriorR);
      const realizedAverage = average(bucket.realizedR);
      return {
        policyDecision,
        evaluatedCandidates: bucket.candidates.length,
        enteredCandidates,
        closedTrades: bucket.realizedR.length,
        policyBlockedCandidates: bucket.candidates.filter((candidate) => candidate.decision === "policy_blocked").length,
        averageRealizedR: realizedAverage,
        winRate: bucket.realizedR.length > 0
          ? Number((bucket.realizedR.filter((value) => value > 0).length / bucket.realizedR.length).toFixed(3))
          : null,
        averagePolicyPriorR: policyPriorAverage,
        averageActualMinusPolicyR:
          realizedAverage !== null && policyPriorAverage !== null
            ? Number((realizedAverage - policyPriorAverage).toFixed(3))
            : null,
      };
    })
    .sort((left, right) => {
      if (right.closedTrades !== left.closedTrades) {
        return right.closedTrades - left.closedTrades;
      }
      return right.evaluatedCandidates - left.evaluatedCandidates;
    });

  const enteredCandidates = candidatesWithPolicy.filter((candidate) => candidate.paper_trade_id).length;
  const closedCandidates = bucketSummaries.reduce((sum, bucket) => sum + bucket.closedTrades, 0);
  const policyBlockedCandidates = candidatesWithPolicy.filter((candidate) => candidate.decision === "policy_blocked").length;
  const shadowTrackedCandidates = candidates.filter((candidate) => !candidate.paper_trade_id).length;
  const bestClosedBucket = bucketSummaries
    .filter((bucket) => bucket.closedTrades > 0 && bucket.averageRealizedR !== null)
    .sort((left, right) => (right.averageRealizedR ?? -Infinity) - (left.averageRealizedR ?? -Infinity))[0] ?? null;

  return {
    evaluatedCandidates: candidates.length,
    candidatesWithPolicy: candidatesWithPolicy.length,
    enteredCandidates,
    closedCandidates,
    policyBlockedCandidates,
    shadowTrackedCandidates,
    buckets: bucketSummaries,
    summary: bestClosedBucket
      ? `Policy audit: ${candidatesWithPolicy.length} policy-scored candidate(s), ${closedCandidates} closed linked outcome(s), ${policyBlockedCandidates} policy block(s). Best observed policy bucket so far: ${bestClosedBucket.policyDecision} at ${bestClosedBucket.averageRealizedR?.toFixed(2)}R avg over ${bestClosedBucket.closedTrades}.`
      : `Policy audit: ${candidatesWithPolicy.length} policy-scored candidate(s), ${policyBlockedCandidates} policy block(s), ${shadowTrackedCandidates} shadow/audit candidate(s). Closed linked outcomes are still sparse.`,
  };
}

function isOptionPositionSymbol(symbol: string): boolean {
  return /\b\d{6}[CP]\d+(?:\.\d+)?\b/i.test(symbol);
}

function estimatePositionCostUsd(position: {
  symbol: string;
  quantity: number | null;
  averagePrice: number | null;
  marketValue: number | null;
  unrealizedPl: number | null;
}): number | null {
  const quantity = Math.abs(position.quantity ?? 0);
  if (quantity <= 0) {
    return null;
  }

  if (position.averagePrice !== null && position.averagePrice > 0) {
    const multiplier = isOptionPositionSymbol(position.symbol) ? 100 : 1;
    return Number((position.averagePrice * quantity * multiplier).toFixed(2));
  }

  if (position.marketValue !== null && position.unrealizedPl !== null) {
    return Number((position.marketValue - position.unrealizedPl).toFixed(2));
  }

  return null;
}

function buildPositionSizingSnapshot(
  positionsPayload: unknown,
): Pick<
  PaperTraderStatus["sizing"],
  | "openPositionCount"
  | "openContractCount"
  | "openPositionCostUsd"
  | "openPositionMarketValueUsd"
  | "positions"
> {
  const positions = extractPositionSnapshots(positionsPayload)
    .map((position) => {
      const estimatedCostUsd = estimatePositionCostUsd(position);
      return {
        symbol: position.symbol,
        quantity: position.quantity,
        averagePrice: position.averagePrice,
        marketValueUsd: position.marketValue,
        unrealizedPlUsd: position.unrealizedPl,
        estimatedCostUsd,
      };
    })
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  const hasMarketValue = positions.some((position) => position.marketValueUsd !== null);
  const hasEstimatedCost = positions.some((position) => position.estimatedCostUsd !== null);
  const openPositionMarketValueUsd = positions.reduce((sum, position) =>
    sum + (position.marketValueUsd ?? 0), 0);
  const openPositionCostUsd = positions.reduce((sum, position) =>
    sum + (position.estimatedCostUsd ?? 0), 0);

  return {
    openPositionCount: positions.length,
    openContractCount: positions.reduce((sum, position) =>
      sum + Math.abs(position.quantity ?? 0), 0),
    openPositionCostUsd: hasEstimatedCost
      ? Number(openPositionCostUsd.toFixed(2))
      : null,
    openPositionMarketValueUsd: hasMarketValue
      ? Number(openPositionMarketValueUsd.toFixed(2))
      : null,
    positions,
  };
}

async function loadPaperTraderSizingSnapshot(
  config: PaperTraderConfig,
): Promise<PaperTraderStatus["sizing"]> {
  if (!config.accountId) {
    return {
      accountValueUsd: null,
      unrealizedPlUsd: null,
      equitiesBuyingPowerUsd: null,
      optionsBuyingPowerUsd: null,
      maxPositionCostUsd: null,
      openPositionCount: null,
      openContractCount: null,
      openPositionCostUsd: null,
      openPositionMarketValueUsd: null,
      positions: [],
      error: "Missing paper-trader account id.",
    };
  }

  try {
    const client = await createAutomationTradeStationClient(config.automationBaseUrl);
    const balancesPayload = await client.getBalances(config.accountId);
    let positionsPayload: unknown = null;
    try {
      positionsPayload = await client.getPositions(config.accountId);
    } catch {
      positionsPayload = null;
    }
    const positionSizing = buildPositionSizingSnapshot(positionsPayload);
    const accountValueUsd = extractAccountValue(balancesPayload);
    const unrealizedPlUsd = extractUnrealizedPl(balancesPayload)
      ?? extractPositionsUnrealizedPl(positionsPayload);
    return {
      accountValueUsd,
      unrealizedPlUsd,
      equitiesBuyingPowerUsd: extractEquitiesBuyingPower(balancesPayload),
      optionsBuyingPowerUsd: extractOptionsBuyingPower(balancesPayload),
      maxPositionCostUsd:
        accountValueUsd !== null
          ? Number((accountValueUsd * config.maxPositionPct).toFixed(2))
          : null,
      ...positionSizing,
      error: accountValueUsd === null
        ? "Could not read SIM account value from TradeStation balances."
        : null,
    };
  } catch (error) {
    return {
      accountValueUsd: null,
      unrealizedPlUsd: null,
      equitiesBuyingPowerUsd: null,
      optionsBuyingPowerUsd: null,
      maxPositionCostUsd: null,
      openPositionCount: null,
      openContractCount: null,
      openPositionCostUsd: null,
      openPositionMarketValueUsd: null,
      positions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getPaperTraderSizingSnapshot(): Promise<PaperTraderStatus["sizing"]> {
  return await loadPaperTraderSizingSnapshot(readPaperTraderConfig());
}

function findFirstNumberByKeys(value: unknown, keys: string[]): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findFirstNumberByKeys(item, keys);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = readNumber(record[key] as string | number | null | undefined);
    if (direct !== null) {
      return direct;
    }
  }

  for (const nested of Object.values(record)) {
    const nestedValue = findFirstNumberByKeys(nested, keys);
    if (nestedValue !== null) {
      return nestedValue;
    }
  }

  return null;
}

function sumNumbersByKeys(value: unknown, keys: string[]): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    let found = false;
    const sum = value.reduce((total, item) => {
      const nested = sumNumbersByKeys(item, keys);
      if (nested !== null) {
        found = true;
        return total + nested;
      }
      return total;
    }, 0);
    return found ? Number(sum.toFixed(2)) : null;
  }

  const record = value as Record<string, unknown>;
  let sum = 0;
  let found = false;
  for (const key of keys) {
    const direct = readNumber(record[key] as string | number | null | undefined);
    if (direct !== null) {
      sum += direct;
      found = true;
    }
  }

  for (const nested of Object.values(record)) {
    const nestedSum = sumNumbersByKeys(nested, keys);
    if (nestedSum !== null) {
      sum += nestedSum;
      found = true;
    }
  }

  return found ? Number(sum.toFixed(2)) : null;
}

function extractAccountValue(payload: unknown): number | null {
  return findFirstNumberByKeys(payload, [
    "NetLiquidationValue",
    "NetLiq",
    "TotalEquity",
    "TotalEquityValue",
    "Equity",
    "AccountValue",
    "CashBalance",
  ]);
}

function extractUnrealizedPl(payload: unknown): number | null {
  return findFirstNumberByKeys(payload, [
    "UnrealizedProfitLoss",
    "UnrealizedProfitLossUSD",
    "UnrealizedPL",
    "UnrealizedPnL",
    "UnrealizedPnl",
    "OpenTradeEquity",
  ]);
}

function extractPositionsUnrealizedPl(payload: unknown): number | null {
  return sumNumbersByKeys(payload, [
    "UnrealizedProfitLoss",
    "UnrealizedProfitLossUSD",
    "UnrealizedPL",
    "UnrealizedPnL",
    "UnrealizedPnl",
  ]);
}

function extractEquitiesBuyingPower(payload: unknown): number | null {
  return findFirstNumberByKeys(payload, [
    "EquitiesBuyingPower",
    "EquityBuyingPower",
    "StockBuyingPower",
    "BuyingPower",
  ]);
}

function extractOptionsBuyingPower(payload: unknown): number | null {
  return findFirstNumberByKeys(payload, [
    "OptionsBuyingPower",
    "OptionBuyingPower",
    "OptionBP",
    "OptionsBP",
    "BuyingPower",
  ]);
}

function extractEntryBuyingPower(payload: unknown): number | null {
  const candidates = [
    findFirstNumberByKeys(payload, ["DayTradeExcess", "DayTradeBuyingPower"]),
    findFirstNumberByKeys(payload, ["OvernightBuyingPower"]),
    extractOptionsBuyingPower(payload),
    findFirstNumberByKeys(payload, ["BuyingPower"]),
  ].filter((value): value is number => value !== null && value >= 0);

  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function computePositionCap(params: {
  requestedContracts: number;
  limitPrice: number;
  accountValueUsd: number;
  entryBuyingPowerUsd: number | null;
  maxPositionPct: number;
}): {
  cappedContracts: number;
  cappedPositionCostUsd: number;
  maxPositionCostUsd: number;
  effectiveMaxPositionCostUsd: number;
  entryBuyingPowerUsd: number | null;
  positionPct: number | null;
} {
  const maxPositionCostUsd = params.accountValueUsd * params.maxPositionPct;
  const effectiveMaxPositionCostUsd =
    params.entryBuyingPowerUsd !== null
      ? Math.min(maxPositionCostUsd, params.entryBuyingPowerUsd)
      : maxPositionCostUsd;
  const maxContractsByCap = Math.floor(effectiveMaxPositionCostUsd / (params.limitPrice * 100));
  const cappedContracts = Math.max(
    0,
    Math.min(params.requestedContracts, maxContractsByCap, MAX_TRADESTATION_CONTRACTS_PER_ORDER),
  );
  const cappedPositionCostUsd = Number((cappedContracts * params.limitPrice * 100).toFixed(2));

  return {
    cappedContracts,
    cappedPositionCostUsd,
    maxPositionCostUsd: Number(maxPositionCostUsd.toFixed(2)),
    effectiveMaxPositionCostUsd: Number(effectiveMaxPositionCostUsd.toFixed(2)),
    entryBuyingPowerUsd:
      params.entryBuyingPowerUsd !== null
        ? Number(params.entryBuyingPowerUsd.toFixed(2))
        : null,
    positionPct:
      params.accountValueUsd > 0
        ? Number((cappedPositionCostUsd / params.accountValueUsd).toFixed(4))
        : null,
  };
}

function splitOrderQuantity(quantity: number): number[] {
  const chunks: number[] = [];
  let remaining = Math.max(0, Math.floor(quantity));
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_TRADESTATION_CONTRACTS_PER_ORDER);
    chunks.push(chunk);
    remaining -= chunk;
  }
  return chunks;
}

async function readHeldOptionQuantity(params: {
  client: AutomationTradeStationClient;
  accountId: string;
  optionSymbol: string;
}): Promise<number> {
  const positions = await params.client.getPositions(params.accountId);
  const position = findPositionSnapshot(positions, params.optionSymbol);
  return Math.max(0, Math.floor(position?.quantity ?? 0));
}

async function placeSellToCloseOrders(params: {
  client: AutomationTradeStationClient;
  getExecutions: AutomationTradeStationClient["getExecutions"];
  accountId: string;
  optionSymbol: string;
  quantity: number;
}): Promise<{
  orderIds: string[];
  averageFillPrice: number | null;
  rejectedOrder: TradeStationOrderResult | null;
}> {
  const orderIds: string[] = [];
  let weightedFillTotal = 0;
  let pricedQuantity = 0;

  for (const chunkQuantity of splitOrderQuantity(params.quantity)) {
    const orderResult = await params.client.placeOrder({
      accountId: params.accountId,
      symbol: params.optionSymbol,
      quantity: chunkQuantity,
      orderType: "Market",
      tradeAction: "SELLTOCLOSE",
      duration: "DAY",
    });

    if (orderResult.orderId) {
      orderIds.push(orderResult.orderId);
    }

    if (isRejectedOrderResult(orderResult)) {
      return {
        orderIds,
        averageFillPrice: null,
        rejectedOrder: orderResult,
      };
    }

    const fillPrice = orderResult.averageFillPrice ?? (
      orderResult.orderId
        ? await getAverageFillPriceIfAvailable({
            getExecutions: params.getExecutions,
            accountId: params.accountId,
            orderId: orderResult.orderId,
          })
        : null
    );

    if (fillPrice !== null && fillPrice > 0) {
      weightedFillTotal += fillPrice * chunkQuantity;
      pricedQuantity += chunkQuantity;
    }
  }

  return {
    orderIds,
    averageFillPrice:
      pricedQuantity > 0
        ? Number((weightedFillTotal / pricedQuantity).toFixed(4))
        : null,
    rejectedOrder: null,
  };
}

function readActiveManagementLevels(
  trade: JournalTradeDetail,
  automation: PaperTraderAutomationSnapshot,
): {
  stopUnderlying: number | null;
  targetUnderlying: number | null;
} {
  return {
    stopUnderlying:
      automation.activeStopUnderlying
      ?? automation.intendedStopUnderlying
      ?? readNumber(trade.intended_stop_underlying),
    targetUnderlying:
      automation.activeTargetUnderlying
      ?? automation.intendedTargetUnderlying
      ?? readNumber(trade.intended_target_underlying),
  };
}

function computeProgressToTargetPct(params: {
  direction: JournalTradeDetail["direction"];
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

  const rawProgress = direction === "CALL"
    ? (currentUnderlyingPrice - entryUnderlyingPrice) / (targetUnderlyingPrice - entryUnderlyingPrice)
    : (entryUnderlyingPrice - currentUnderlyingPrice) / (entryUnderlyingPrice - targetUnderlyingPrice);

  if (!Number.isFinite(rawProgress)) {
    return null;
  }

  return Number((rawProgress * 100).toFixed(1));
}

function computeOptionReturnPct(
  entryOptionPrice: number | null,
  currentOptionMid: number | null,
): number | null {
  if (entryOptionPrice === null || currentOptionMid === null || entryOptionPrice <= 0) {
    return null;
  }

  return Number((((currentOptionMid - entryOptionPrice) / entryOptionPrice) * 100).toFixed(1));
}

function readTradeRationale(trade: JournalTradeDetail): string | null {
  const snapshot = asRecord(trade.signal_snapshot_json);
  const tradeCard = asRecord(snapshot?.tradeCard);
  const presentationSummary = asRecord(snapshot?.presentationSummary);
  const presentationTradeCard = asRecord(presentationSummary?.tradeCard);
  const automation = asRecord(snapshot?.automation);
  const paperTrader = asRecord(automation?.paperTrader);
  const entryReasoning = asRecord(paperTrader?.entryReasoning);
  return typeof tradeCard?.rationale === "string" ? tradeCard.rationale
    : typeof presentationTradeCard?.rationale === "string" ? presentationTradeCard.rationale
    : typeof entryReasoning?.tradeRationale === "string" ? entryReasoning.tradeRationale
    : null;
}

function summarizeCurrentManagementHistory(
  history: PaperTraderManagementHistoryEntry[],
): string | null {
  if (history.length === 0) {
    return null;
  }

  return history
    .slice(-6)
    .map((item) =>
      `${item.timestamp}: ${item.action}${item.confidence ? ` (${item.confidence})` : ""} | stop=${item.stopUnderlying ?? "n/a"} | target=${item.targetUnderlying ?? "n/a"} | ${item.note}`,
    )
    .join("\n");
}

function buildPolicyFeedbackSummary(
  allTrades: JournalTradeDetail[],
  trade: JournalTradeDetail,
): string | null {
  const similarClosedTrades = allTrades
    .filter((candidate) =>
      candidate.id !== trade.id
      && candidate.account_mode === "paper"
      && candidate.status === "closed"
      && candidate.direction === trade.direction
      && candidate.setup_type === trade.setup_type
      && candidate.review
    )
    .slice(0, 6);

  if (similarClosedTrades.length === 0) {
    return null;
  }

  return similarClosedTrades
    .map((candidate) => {
      const candidateAutomation = readAutomationSnapshot(candidate);
      const candidateHistory = readManagementHistory(candidateAutomation);
      const lastAction = candidateHistory.at(-1);
      return [
        `${candidate.symbol} ${candidate.entry_date}`,
        `winner=${candidate.review?.winner === true ? "yes" : "no"}`,
        `realizedR=${readNumber(candidate.review?.realized_r_multiple ?? null) ?? "n/a"}`,
        `exit=${candidate.latest_exit?.exit_reason ?? "n/a"}`,
        `last_action=${lastAction?.action ?? "none"}`,
        `last_note=${lastAction?.note ?? candidate.review?.review_notes ?? "n/a"}`,
      ].join(" | ");
    })
    .join("\n");
}

function summarizeTrainedPolicyRecommendation(
  recommendation: ReturnType<typeof recommendPolicyAction>,
): string | null {
  if (!recommendation.summary) {
    return null;
  }

  const actionLines = (["hold", "update_levels", "exit_now"] as const)
    .map((action) => {
      const summary = recommendation.actionSummaries[action];
      if (!summary) {
        return null;
      }
      return `${action}: count=${summary.count}, avg=${summary.averageRewardR.toFixed(2)}R, win_rate=${(summary.winRate * 100).toFixed(0)}%`;
    })
    .filter((value): value is string => value !== null);

  return [recommendation.summary, ...actionLines].join("\n");
}

function computeTodayRealizedPlUsd(
  trades: JournalTradeDetail[],
  todayChicago: string,
): number {
  return trades
    .filter((trade) =>
      trade.account_mode === "paper"
      && trade.status === "closed"
      && trade.latest_exit
      && toChicagoDateString(trade.latest_exit.exit_time) === todayChicago
    )
    .reduce(
      (sum, trade) => sum + (readNumber(trade.review?.realized_pl_usd ?? null) ?? 0),
      0,
    );
}

function inferExitDecision(params: {
  trade: JournalTradeDetail;
  automation: NonNullable<ReturnType<typeof readAutomationSnapshot>>;
  todayChicago: string;
  underlyingLast: number | null;
  optionMid: number | null;
}): ExitDecision | null {
  const stop =
    params.automation.activeStopUnderlying
    ?? params.automation.intendedStopUnderlying
    ?? readNumber(params.trade.intended_stop_underlying);
  const target =
    params.automation.activeTargetUnderlying
    ?? params.automation.intendedTargetUnderlying
    ?? readNumber(params.trade.intended_target_underlying);
  const timeExitDate = params.automation.timeExitDate ?? null;
  const entryOptionPrice = readNumber(params.trade.option_entry_price);

  if (params.trade.direction === "CALL" && params.underlyingLast !== null) {
    if (typeof stop === "number" && params.underlyingLast <= stop) {
      return {
        reason: "stop_hit",
        note: `Underlying fell to ${params.underlyingLast.toFixed(2)} at/below stop ${stop.toFixed(2)}.`,
      };
    }
    if (typeof target === "number" && params.underlyingLast >= target) {
      return {
        reason: "target_hit",
        note: `Underlying rose to ${params.underlyingLast.toFixed(2)} at/above target ${target.toFixed(2)}.`,
      };
    }
  }

  if (params.trade.direction === "PUT" && params.underlyingLast !== null) {
    if (typeof stop === "number" && params.underlyingLast >= stop) {
      return {
        reason: "stop_hit",
        note: `Underlying rose to ${params.underlyingLast.toFixed(2)} at/above stop ${stop.toFixed(2)}.`,
      };
    }
    if (typeof target === "number" && params.underlyingLast <= target) {
      return {
        reason: "target_hit",
        note: `Underlying fell to ${params.underlyingLast.toFixed(2)} at/below target ${target.toFixed(2)}.`,
      };
    }
  }

  if (timeExitDate && params.todayChicago >= timeExitDate) {
    return {
      reason: "time_exit",
      note: `Time exit reached on ${timeExitDate}.`,
    };
  }

  if (
    params.optionMid !== null
    && entryOptionPrice !== null
    && entryOptionPrice > 0
    && params.optionMid <= entryOptionPrice * 0.75
  ) {
    return {
      reason: "manual_early_exit",
      note: `Option premium decayed to ${params.optionMid.toFixed(2)}, beyond the 25% decay rule from ${entryOptionPrice.toFixed(2)}.`,
    };
  }

  return null;
}

async function getAverageFillPriceIfAvailable(params: {
  getExecutions: (accountId: string, orderId: string) => Promise<unknown>;
  accountId: string;
  orderId: string;
}): Promise<number | null> {
  try {
    const executions = await params.getExecutions(params.accountId, params.orderId);
    return extractAverageFillPrice(executions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("TradeStation request failed (404)")
      && message.includes("No orders were found")
    ) {
      return null;
    }

    throw error;
  }
}

function isRejectedOrderResult(order: { status: string | null }): boolean {
  return order.status?.toLowerCase().includes("reject") ?? false;
}

function formatRejectedOrderReason(order: {
  orderId: string | null;
  status: string | null;
  rejectReason: string | null;
}): string {
  return [
    "TradeStation rejected the SIM order",
    order.orderId ? ` ${order.orderId}` : "",
    order.status ? ` (${order.status})` : "",
    order.rejectReason ? `: ${order.rejectReason}` : ".",
  ].join("");
}

async function finalizePaperTraderRunResult(
  result: PaperTraderRunResultCore,
  tradesForHistory: JournalTradeDetail[],
  includeHistory: boolean,
): Promise<PaperTraderRunResult> {
  const resultWithTradeHistory = {
    ...result,
    decisionLog: collectRecentDecisionLog(tradesForHistory),
    paperTradeHistory: buildPaperTradeHistory(tradesForHistory),
    entryCandidateHistory: [],
    entryCandidateHistoryMigrationRequired: false,
    entryCandidateHistoryMigrationMessage: null,
    runHistory: [],
    runHistoryMigrationRequired: false,
    runHistoryMigrationMessage: null,
  } satisfies PaperTraderRunResult;

  let writeWarning: string | null = null;
  try {
    await recordPaperTraderRun({
      mode: result.mode,
      dryRun: result.dryRun,
      outcome: result.entry.outcome,
      symbol: result.entry.symbol,
      reason: result.entry.reason,
      rawResult: resultWithTradeHistory as unknown as Record<string, unknown>,
    });
  } catch (error) {
    writeWarning = formatNonCriticalHistoryError("Paper trader run history write", error);
  }

  const runHistory = includeHistory
    ? await loadPaperTraderRunHistory()
    : {
        runHistory: [],
        runHistoryMigrationRequired: false,
        runHistoryMigrationMessage: null,
      };
  const entryCandidateHistory = includeHistory
    ? await loadPaperEntryCandidateHistory()
    : {
        entryCandidateHistory: [],
        entryCandidateHistoryMigrationRequired: false,
        entryCandidateHistoryMigrationMessage: null,
      };
  return {
    ...resultWithTradeHistory,
    ...runHistory,
    ...entryCandidateHistory,
    runHistoryMigrationMessage:
      writeWarning
      ?? runHistory.runHistoryMigrationMessage,
  };
}

export async function getPaperTraderStatus(): Promise<PaperTraderStatus> {
  const config = readPaperTraderConfig();
  const loadedTrades = await loadJournalTradesForPaperTraderStatus();
  const trades = loadedTrades.trades;
  const configurationIssues = buildPaperTraderConfigurationIssues(config);
  const policyModel = trainPolicyModel(trades);
  const entryRewardModel = trainEntryRewardModel(trades);
  const runHistory = await loadPaperTraderRunHistory();
  const entryCandidateHistory = await loadPaperEntryCandidateHistory(200);
  const sizing = await loadPaperTraderSizingSnapshot(config);
  const openJournalTrades = trades.filter(
    (trade) => trade.account_mode === "paper" && trade.status === "open",
  );
  const liveSimPositions = sizing.openPositionCount;
  const staleOpenJournalTrades =
    liveSimPositions === null
      ? null
      : Math.max(0, openJournalTrades.length - liveSimPositions);
  const entryPolicyEffectiveness = buildEntryPolicyEffectivenessSummary(
    trades,
    entryCandidateHistory.entryCandidateHistory,
  );

  return {
    enabled: config.enabled,
    allowOrderPlacement: config.allowOrderPlacement,
    liveRunReady: configurationIssues.length === 0,
    automationBaseUrl: config.automationBaseUrl,
    accountIdConfigured: config.accountId !== null,
    maxOpenTrades: config.maxOpenTrades,
    maxDailyLossUsd: config.maxDailyLossUsd,
    maxPositionPct: config.maxPositionPct,
    requiresSecret: config.apiSecret !== null,
    openPaperTrades: openJournalTrades.length,
    liveSimPositions,
    staleOpenJournalTrades,
    sizing,
    configurationIssues,
    dataWarnings: loadedTrades.warning ? [loadedTrades.warning] : [],
    learning: {
      closedPaperTrades: policyModel.closedTradeCount,
      managementExperiences: policyModel.experienceCount,
      entryExperiences: entryRewardModel.experienceCount,
      entryLearnedContexts: Object.keys(entryRewardModel.buckets).length,
      learnedContexts: Object.keys(policyModel.buckets).length,
      readyForPolicyPrior: entryRewardModel.experienceCount >= 3,
      entryFeatureCoverage: entryRewardModel.featureCoverage,
      entryPolicySummary: summarizeEntryRewardModel(entryRewardModel),
      entryPolicyEffectiveness,
    },
    recentDecisionLog: collectRecentDecisionLog(trades),
    paperTradeHistory: buildPaperTradeHistory(trades),
    ...entryCandidateHistory,
    ...runHistory,
  };
}

function readAutomationQuantity(
  trade: JournalTradeDetail,
  automation: PaperTraderAutomationSnapshot,
): number | null {
  return automation.requestedQuantity
    ?? automation.quantity
    ?? trade.contracts
    ?? null;
}

function computeFillStatus(params: {
  filledQuantity: number | null;
  requestedQuantity: number | null;
}): "unfilled" | "partial" | "filled" | "unknown" {
  if (params.filledQuantity === null) {
    return "unknown";
  }
  if (params.filledQuantity <= 0) {
    return "unfilled";
  }
  if (
    params.requestedQuantity !== null
    && params.filledQuantity < params.requestedQuantity
  ) {
    return "partial";
  }
  return "filled";
}

function parseTradeStationOptionSymbol(symbol: string): {
  underlying: string;
  expirationDate: string | null;
  direction: "CALL" | "PUT";
} | null {
  const match = symbol.trim().match(/^([A-Z.]+)\s+(\d{2})(\d{2})(\d{2})([CP])\d+(?:\.\d+)?$/i);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) {
    return null;
  }

  return {
    underlying: match[1].toUpperCase(),
    expirationDate: `20${match[2]}-${match[3]}-${match[4]}`,
    direction: match[5].toUpperCase() === "C" ? "CALL" : "PUT",
  };
}

function optionSymbolsForOpenTrades(trades: JournalTradeDetail[]): Set<string> {
  return new Set(
    trades
      .map((trade) => readAutomationSnapshot(trade)?.optionSymbol)
      .filter((symbol): symbol is string => typeof symbol === "string" && symbol.length > 0)
      .map((symbol) => symbol.replace(/\s+/g, "").toUpperCase()),
  );
}

function normalizeOptionSymbolForMatch(symbol: string): string {
  return symbol.replace(/\s+/g, "").toUpperCase();
}

function appendEntryNote(existing: string | null, note: string): string {
  return [existing, note].filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0
  ).join("\n");
}

function numbersDiffer(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left !== right;
  }
  return Math.abs(left - right) > 0.0001;
}

async function adoptUnlinkedLiveSimPositions(params: {
  config: PaperTraderConfig;
  client: AutomationTradeStationClient;
  accountId: string;
  positionsPayload: unknown;
  openPaperTrades: JournalTradeDetail[];
  updateJournal: boolean;
}): Promise<{
  adopted: number;
  updates: PaperTraderRunResult["reconciliation"]["updates"];
}> {
  if (!params.updateJournal) {
    return { adopted: 0, updates: [] };
  }

  const linkedOptionSymbols = optionSymbolsForOpenTrades(params.openPaperTrades);
  const livePositions = extractPositionSnapshots(params.positionsPayload);
  const updates: PaperTraderRunResult["reconciliation"]["updates"] = [];
  let adopted = 0;

  for (const position of livePositions) {
    if (linkedOptionSymbols.has(normalizeOptionSymbolForMatch(position.symbol))) {
      continue;
    }

    const parsed = parseTradeStationOptionSymbol(position.symbol);
    const quantity = Math.abs(position.quantity ?? 0);
    if (!parsed || quantity <= 0) {
      continue;
    }

    let underlyingEntryPrice: number | null = null;
    try {
      underlyingEntryPrice = (await params.client.fetchQuote(parsed.underlying)).last;
    } catch {
      underlyingEntryPrice = null;
    }

    const optionEntryPrice = position.averagePrice ?? null;
    const positionCostUsd =
      optionEntryPrice !== null
        ? Number((quantity * optionEntryPrice * 100).toFixed(2))
        : Math.max(1, Math.abs(position.marketValue ?? 0));
    const now = new Date();
    const chicagoNow = formatChicagoParts(now);
    const decisionLog: PaperTraderDecisionLogEntry[] = [{
      timestamp: now.toISOString(),
      symbol: parsed.underlying,
      kind: "order_check",
      action: "adopted_live_sim_position",
      note: `Adopted live TradeStation SIM position ${position.symbol} into the paper journal because no open journal row was linked to it.`,
      optionSymbol: position.symbol,
      quantity,
    }];

    const createdTrade = await createJournalTrade({
      account_mode: "paper",
      entry_date: chicagoNow.date,
      entry_time: chicagoNow.time,
      contracts: quantity,
      option_entry_price: optionEntryPrice,
      entry_notes: "Adopted from live TradeStation SIM position during paper-trader reconciliation.",
      planned_trade: {
        symbol: parsed.underlying,
        direction: parsed.direction,
        expiration_date: parsed.expirationDate,
        position_cost_usd: positionCostUsd,
        underlying_entry_price: underlyingEntryPrice,
        planned_risk_usd: null,
        planned_profit_usd: null,
        setup_type: "adopted_sim_position",
        setup_subtype: "reconciliation",
        confidence_bucket: "adopted",
        intended_stop_underlying: null,
        intended_target_underlying: null,
        market_regime: "unknown",
      },
      signal_snapshot_json: {
        automation: {
          lane: "paper_trader_v1",
          paperTrader: {
            accountId: params.accountId,
            optionSymbol: position.symbol,
            quantity,
            requestedQuantity: quantity,
            filledQuantity: quantity,
            remainingQuantity: 0,
            entryAverageFillPrice: optionEntryPrice,
            entryFillStatus: "filled",
            lastOrderStatus: "filled",
            lastOrderCheckAt: now.toISOString(),
            lastPositionQuantity: quantity,
            managementStyle: "ai",
            lastManagementAction: "hold",
            lastManagementConfidence: "medium",
            lastManagementNote: "Live SIM position adopted. AI management can review it on the next cycle.",
            lastManagementThesis: "Adopted live SIM position without original scanner thesis.",
            lastManagementAt: now.toISOString(),
            managementHistory: [],
            decisionLog,
            maxPositionPct: params.config.maxPositionPct,
          },
        },
      },
      status: "open",
    });

    linkedOptionSymbols.add(normalizeOptionSymbolForMatch(position.symbol));
    adopted += 1;
    updates.push({
      tradeId: createdTrade.id,
      symbol: parsed.underlying,
      orderId: null,
      fillStatus: "filled",
      filledQuantity: quantity,
      requestedQuantity: quantity,
      remainingQuantity: 0,
      averageFillPrice: optionEntryPrice,
      note: `Adopted live SIM position ${position.symbol} into the paper journal.`,
    });
  }

  return { adopted, updates };
}

async function reconcileOpenPaperOrders(
  config: PaperTraderConfig,
  allTrades: JournalTradeDetail[],
  updateJournal: boolean,
): Promise<PaperTraderRunResult["reconciliation"]> {
  const openPaperTrades = allTrades.filter(
    (trade) => trade.account_mode === "paper" && trade.status === "open",
  );
  const client = await createAutomationTradeStationClient(config.automationBaseUrl);
  if (openPaperTrades.length === 0) {
    if (config.accountId) {
      const positionsPayload = await client.getPositions(config.accountId);
      const adoption = await adoptUnlinkedLiveSimPositions({
        config,
        client,
        accountId: config.accountId,
        positionsPayload,
        openPaperTrades,
        updateJournal,
      });
      return {
        inspected: 0,
        updated: adoption.adopted,
        partialFills: 0,
        staleArchived: 0,
        adoptedPositions: adoption.adopted,
        updates: adoption.updates,
        skipped: [],
      };
    }
    return {
      inspected: 0,
      updated: 0,
      partialFills: 0,
      staleArchived: 0,
      adoptedPositions: 0,
      updates: [],
      skipped: [],
    };
  }

  const positionPayloads = new Map<string, unknown>();
  const updates: PaperTraderRunResult["reconciliation"]["updates"] = [];
  const skipped: PaperTraderRunResult["reconciliation"]["skipped"] = [];
  let updated = 0;
  let partialFills = 0;
  let staleArchived = 0;

  for (const trade of openPaperTrades) {
    const automation = readAutomationSnapshot(trade);
    if (!automation?.accountId || !automation.optionSymbol) {
      const reason = "Missing paper-trader order metadata for reconciliation; archived this stale local journal row because TradeStation SIM positions are the source of truth.";
      if (updateJournal) {
        await archiveJournalTradeWithoutReview(trade.id, {
          entry_notes: appendEntryNote(trade.entry_notes, reason),
        });
        staleArchived += 1;
        updated += 1;
      } else {
        skipped.push({
          tradeId: trade.id,
          symbol: trade.symbol,
          reason,
        });
      }
      continue;
    }

    const requestedQuantity = readAutomationQuantity(trade, automation);
    let executionFilledQuantity: number | null = null;
    let executionAveragePrice: number | null = null;
    let orderCheckError: string | null = null;

    if (automation.orderId) {
      try {
        const executions = await client.getExecutions(automation.accountId, automation.orderId);
        const executionSummary = summarizeExecutions(executions);
        executionFilledQuantity = executionSummary.filledQuantity;
        executionAveragePrice = executionSummary.averageFillPrice;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("TradeStation request failed (404)")) {
          orderCheckError = message;
        }
      }
    }

    let accountPositions = positionPayloads.get(automation.accountId);
    if (!accountPositions) {
      accountPositions = await client.getPositions(automation.accountId);
      positionPayloads.set(automation.accountId, accountPositions);
    }
    const position = findPositionSnapshot(accountPositions, automation.optionSymbol);
    const positionQuantity = position?.quantity !== null && position?.quantity !== undefined
      ? Math.abs(position.quantity)
      : null;
    const filledQuantity =
      executionFilledQuantity
      ?? positionQuantity
      ?? automation.filledQuantity
      ?? null;
    const averageFillPrice =
      executionAveragePrice
      ?? position?.averagePrice
      ?? automation.entryAverageFillPrice
      ?? readNumber(trade.option_entry_price)
      ?? null;
    const remainingQuantity =
      requestedQuantity !== null && filledQuantity !== null
        ? Math.max(0, requestedQuantity - filledQuantity)
        : null;
    const fillStatus = computeFillStatus({ filledQuantity, requestedQuantity });
    if (fillStatus === "partial") {
      partialFills += 1;
    }
    const missingLivePosition = !position || positionQuantity === null || positionQuantity <= 0;
    if (fillStatus === "unknown" && orderCheckError === null) {
      orderCheckError =
        `No executions or live SIM position were found for ${automation.optionSymbol}; fill status remains unknown until TradeStation returns order evidence.`;
    }
    const shouldArchiveStaleRow = missingLivePosition;

    const shouldLogOrderCheck =
      fillStatus !== automation.entryFillStatus
      || orderCheckError !== null;
    const decisionLog = shouldLogOrderCheck
      ? appendDecisionLog(readDecisionLog(automation), {
          timestamp: new Date().toISOString(),
          tradeId: trade.id,
          symbol: trade.symbol,
          kind: "order_check",
          action: fillStatus,
          note: orderCheckError
            ? `Order check warning: ${orderCheckError}`
            : `Order check found ${fillStatus} fill status for ${automation.optionSymbol}.`,
          optionSymbol: automation.optionSymbol,
          orderId: automation.orderId ?? null,
          quantity: filledQuantity,
        })
      : readDecisionLog(automation);
    const snapshotUpdates = {
      requestedQuantity,
      ...(filledQuantity !== null ? { quantity: filledQuantity } : {}),
      filledQuantity,
      remainingQuantity,
      entryAverageFillPrice: averageFillPrice,
      entryFillStatus: fillStatus,
      lastOrderStatus: fillStatus,
      lastOrderCheckAt: new Date().toISOString(),
      lastOrderCheckError: orderCheckError,
      lastPositionQuantity: positionQuantity,
      ...(shouldLogOrderCheck ? { decisionLog } : {}),
    };

    if (updateJournal) {
      const updatedSnapshot = buildUpdatedSignalSnapshot(trade, {
        ...snapshotUpdates,
        ...(shouldArchiveStaleRow ? { staleReconciledAt: new Date().toISOString() } : {}),
      });
      await updateJournalTradeSignalSnapshot(trade.id, updatedSnapshot);

      if (
        filledQuantity !== null
        && filledQuantity > 0
        && !shouldArchiveStaleRow
        && (
          numbersDiffer(trade.contracts, filledQuantity)
          || numbersDiffer(readNumber(trade.option_entry_price), averageFillPrice)
        )
      ) {
        await updateJournalTrade(trade.id, {
          contracts: filledQuantity,
          ...(averageFillPrice !== null ? { option_entry_price: averageFillPrice } : {}),
        });
      }
      if (shouldArchiveStaleRow) {
        await archiveJournalTradeWithoutReview(trade.id, {
          entry_notes: appendEntryNote(
            trade.entry_notes,
            `Archived by paper-trader reconciliation: no live TradeStation SIM position for ${automation.optionSymbol}.`,
          ),
        });
        staleArchived += 1;
      }
      updated += 1;
    }

    updates.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      orderId: automation.orderId ?? null,
      fillStatus,
      filledQuantity,
      requestedQuantity,
      remainingQuantity,
      averageFillPrice,
      note: orderCheckError
        ? `Order check warning: ${orderCheckError}`
        : `Reconciled ${automation.optionSymbol}: ${fillStatus}.`,
      archived: shouldArchiveStaleRow && updateJournal,
    });
  }

  let adoptedPositions = 0;
  if (config.accountId) {
    let accountPositions = positionPayloads.get(config.accountId);
    if (!accountPositions) {
      accountPositions = await client.getPositions(config.accountId);
      positionPayloads.set(config.accountId, accountPositions);
    }
    const adoption = await adoptUnlinkedLiveSimPositions({
      config,
      client,
      accountId: config.accountId,
      positionsPayload: accountPositions,
      openPaperTrades,
      updateJournal,
    });
    adoptedPositions = adoption.adopted;
    updates.push(...adoption.updates);
    updated += adoption.adopted;
  }

  return {
    inspected: openPaperTrades.length,
    updated,
    partialFills,
    staleArchived,
    adoptedPositions,
    updates,
    skipped,
  };
}

async function manageOpenPaperTrades(
  config: PaperTraderConfig,
  dryRun: boolean,
  allTrades: JournalTradeDetail[],
): Promise<PaperTraderRunResult["management"]> {
  const openPaperTrades = allTrades.filter(
    (trade) => trade.account_mode === "paper" && trade.status === "open",
  );
  const trainedPolicyModel = trainPolicyModel(allTrades);
  const client = await createAutomationTradeStationClient(config.automationBaseUrl);
  const nowIso = new Date().toISOString();
  const todayChicago = formatChicagoParts(new Date()).date;
  const updates: PaperTraderRunResult["management"]["updates"] = [];
  const exitsTriggered: PaperTraderRunResult["management"]["exitsTriggered"] = [];
  const skipped: PaperTraderRunResult["management"]["skipped"] = [];
  const positionPayloads = new Map<string, unknown>();
  let inspected = 0;

  for (const trade of openPaperTrades) {
    const automation = readAutomationSnapshot(trade);
    if (!automation?.optionSymbol || !automation.accountId || !automation.quantity) {
      skipped.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: "Missing automation metadata required for position management.",
      });
      continue;
    }

    let accountPositions: unknown;
    try {
      accountPositions = positionPayloads.get(automation.accountId);
      if (!accountPositions) {
        accountPositions = await client.getPositions(automation.accountId);
        positionPayloads.set(automation.accountId, accountPositions);
      }
    } catch (error) {
      skipped.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: `Could not verify live TradeStation SIM position before management: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const livePosition = findPositionSnapshot(accountPositions, automation.optionSymbol);
    if (!livePosition || Math.abs(livePosition.quantity ?? 0) <= 0) {
      skipped.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: `No live TradeStation SIM position found for ${automation.optionSymbol}; skipped AI management for this stale journal row.`,
      });
      continue;
    }

    inspected += 1;
    let decisionLog = readDecisionLog(automation);
    let currentSnapshotUpdates: Record<string, unknown> = {};
    const [underlyingQuote, optionQuote] = await Promise.all([
      client.fetchQuote(trade.symbol),
      client.fetchQuote(automation.optionSymbol),
    ]);
    const activeLevels = readActiveManagementLevels(trade, automation);
    const progressToTargetPct = computeProgressToTargetPct({
      direction: trade.direction,
      entryUnderlyingPrice: readNumber(trade.underlying_entry_price),
      currentUnderlyingPrice: underlyingQuote.last,
      targetUnderlyingPrice: activeLevels.targetUnderlying,
    });
    const optionReturnPct = computeOptionReturnPct(
      readNumber(trade.option_entry_price),
      optionQuote.mid,
    );
    const trainedPolicyRecommendation = recommendPolicyAction(trainedPolicyModel, {
      direction: trade.direction,
      setupType: trade.setup_type,
      confidenceBucket: trade.confidence_bucket,
      progressToTargetPct,
      optionReturnPct,
      dteAtEntry: trade.dte_at_entry,
    });
    let effectiveAutomation: PaperTraderAutomationSnapshot = {
      ...automation,
      ...(activeLevels.stopUnderlying !== null
        ? { activeStopUnderlying: activeLevels.stopUnderlying }
        : {}),
      ...(activeLevels.targetUnderlying !== null
        ? { activeTargetUnderlying: activeLevels.targetUnderlying }
        : {}),
    };
    let aiDecisionNote: string | null = null;
    let decision = null as ExitDecision | null;

    try {
      const managementHistory = readManagementHistory(automation);
      const aiDecision = enforceAiManagementGuardrails(
        trade.direction,
        activeLevels.stopUnderlying,
        activeLevels.targetUnderlying,
        underlyingQuote.last,
        await decideAiManagementAction({
          symbol: trade.symbol,
          direction: trade.direction,
          setupType: trade.setup_type,
          confidenceBucket: trade.confidence_bucket,
          entryDate: trade.entry_date,
          expirationDate: trade.expiration_date,
          dteAtEntry: trade.dte_at_entry,
          underlyingEntryPrice: readNumber(trade.underlying_entry_price),
          optionEntryPrice: readNumber(trade.option_entry_price),
          currentUnderlyingPrice: underlyingQuote.last,
          currentOptionMid: optionQuote.mid,
          currentStopUnderlying: activeLevels.stopUnderlying,
          currentTargetUnderlying: activeLevels.targetUnderlying,
          originalStopUnderlying:
            automation.intendedStopUnderlying
            ?? readNumber(trade.intended_stop_underlying),
          originalTargetUnderlying:
            automation.intendedTargetUnderlying
            ?? readNumber(trade.intended_target_underlying),
          timeExitDate: automation.timeExitDate ?? null,
          progressToTargetPct,
          optionReturnPct,
          rationale: readTradeRationale(trade),
          lastManagementNote: automation.lastManagementNote ?? null,
          lastManagementThesis: automation.lastManagementThesis ?? null,
          managementHistorySummary: summarizeCurrentManagementHistory(managementHistory),
          policyFeedbackSummary: buildPolicyFeedbackSummary(allTrades, trade),
          trainedPolicySummary: summarizeTrainedPolicyRecommendation(trainedPolicyRecommendation),
          trainedPolicyRecommendedAction: trainedPolicyRecommendation.recommendedAction,
        }),
      );

      aiDecisionNote = `${aiDecision.thesis} ${aiDecision.note}`;
      const nextStopUnderlying = aiDecision.updatedStopUnderlying ?? activeLevels.stopUnderlying;
      const nextTargetUnderlying = aiDecision.updatedTargetUnderlying ?? activeLevels.targetUnderlying;
      const historyEntry: PaperTraderManagementHistoryEntry = {
        timestamp: nowIso,
        action: aiDecision.action,
        confidence: aiDecision.confidence,
        stopUnderlying: nextStopUnderlying,
        targetUnderlying: nextTargetUnderlying,
        currentUnderlyingPrice: underlyingQuote.last,
        currentOptionMid: optionQuote.mid,
        progressToTargetPct,
        optionReturnPct,
        note: aiDecision.note,
        thesis: aiDecision.thesis,
      };
      const decisionLogEntry: PaperTraderDecisionLogEntry = {
        timestamp: nowIso,
        tradeId: trade.id,
        symbol: trade.symbol,
        kind: "management",
        action: aiDecision.action,
        confidence: aiDecision.confidence,
        note: aiDecision.note,
        thesis: aiDecision.thesis,
        plainEnglishExplanation: aiDecision.plainEnglishExplanation,
        optionSymbol: automation.optionSymbol,
        quantity: automation.quantity,
        stopUnderlying: nextStopUnderlying,
        targetUnderlying: nextTargetUnderlying,
        currentUnderlyingPrice: underlyingQuote.last,
        currentOptionMid: optionQuote.mid,
        positionPct: null,
      };
      decisionLog = appendDecisionLog(decisionLog, decisionLogEntry);
      currentSnapshotUpdates = {
        activeStopUnderlying: nextStopUnderlying,
        activeTargetUnderlying: nextTargetUnderlying,
        managementStyle: "ai",
        lastManagementAction: aiDecision.action,
        lastManagementConfidence: aiDecision.confidence,
        lastManagementNote: aiDecision.note,
        lastManagementThesis: aiDecision.thesis,
        lastManagementAt: nowIso,
        managementHistory: appendManagementHistory(managementHistory, historyEntry),
        decisionLog,
      };

      if (!dryRun) {
        await updateJournalTradeSignalSnapshot(
          trade.id,
          buildUpdatedSignalSnapshot(trade, currentSnapshotUpdates),
        );
      }

      effectiveAutomation = {
        ...effectiveAutomation,
        ...(nextStopUnderlying !== null
          ? { activeStopUnderlying: nextStopUnderlying }
          : {}),
        ...(nextTargetUnderlying !== null
          ? { activeTargetUnderlying: nextTargetUnderlying }
          : {}),
        managementStyle: "ai",
        lastManagementAction: aiDecision.action,
        lastManagementConfidence: aiDecision.confidence,
        lastManagementNote: aiDecision.note,
        lastManagementThesis: aiDecision.thesis,
        lastManagementAt: nowIso,
      };

      updates.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        action:
          aiDecision.action === "hold"
            ? "ai_hold"
            : aiDecision.action === "update_levels"
              ? "ai_update_levels"
              : "ai_exit_now",
        stopUnderlying: nextStopUnderlying,
        targetUnderlying: nextTargetUnderlying,
        note: aiDecisionNote,
      });

      if (aiDecision.action === "exit_now") {
        decision = {
          reason: "manual_early_exit",
          note: `AI manager chose exit-now. ${aiDecisionNote}`,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown AI manager error.";
      updates.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        action: "ai_fallback",
        stopUnderlying: activeLevels.stopUnderlying,
        targetUnderlying: activeLevels.targetUnderlying,
        note: `AI manager unavailable; falling back to hard exits. ${message}`,
      });
    }

    if (!decision) {
      decision = inferExitDecision({
        trade,
        automation: effectiveAutomation,
        todayChicago,
        underlyingLast: underlyingQuote.last,
        optionMid: optionQuote.mid,
      });
    }

    if (!decision) {
      skipped.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: aiDecisionNote ?? "No stop, target, time, or premium-decay exit trigger fired.",
      });
      continue;
    }

    if (dryRun) {
      exitsTriggered.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: decision.reason,
        action: "would_close",
        orderId: automation.orderId ?? null,
        optionExitPrice: optionQuote.mid,
        note: decision.note,
      });
      continue;
    }

    let heldQuantity: number;
    try {
      heldQuantity = await readHeldOptionQuantity({
        client,
        accountId: automation.accountId,
        optionSymbol: automation.optionSymbol,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      decisionLog = appendDecisionLog(decisionLog, {
        timestamp: nowIso,
        tradeId: trade.id,
        symbol: trade.symbol,
        kind: "exit",
        action: "exit_position_check_failed",
        reason: decision.reason,
        note: `${decision.note} Exit skipped because the SIM position check failed: ${message}`,
        optionSymbol: automation.optionSymbol,
        orderId: automation.orderId ?? null,
        quantity: automation.quantity,
        currentUnderlyingPrice: underlyingQuote.last,
        currentOptionMid: optionQuote.mid,
      });
      await updateJournalTradeSignalSnapshot(
        trade.id,
        buildUpdatedSignalSnapshot(trade, { ...currentSnapshotUpdates, decisionLog }),
      );
      exitsTriggered.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: decision.reason,
        action: "skipped",
        orderId: automation.orderId ?? null,
        optionExitPrice: null,
        note: `${decision.note} Exit skipped because the SIM position check failed: ${message}`,
      });
      continue;
    }

    if (heldQuantity < 1) {
      decisionLog = appendDecisionLog(decisionLog, {
        timestamp: nowIso,
        tradeId: trade.id,
        symbol: trade.symbol,
        kind: "exit",
        action: "exit_skipped_no_position",
        reason: decision.reason,
        note: `${decision.note} Exit skipped because TradeStation reports 0 long contracts for ${automation.optionSymbol}.`,
        optionSymbol: automation.optionSymbol,
        orderId: automation.orderId ?? null,
        quantity: 0,
        currentUnderlyingPrice: underlyingQuote.last,
        currentOptionMid: optionQuote.mid,
      });
      await updateJournalTradeSignalSnapshot(
        trade.id,
        buildUpdatedSignalSnapshot(trade, {
          ...currentSnapshotUpdates,
          quantity: 0,
          filledQuantity: 0,
          remainingQuantity: 0,
          lastPositionQuantity: 0,
          lastOrderCheckAt: nowIso,
          decisionLog,
        }),
      );
      exitsTriggered.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: decision.reason,
        action: "skipped",
        orderId: automation.orderId ?? null,
        optionExitPrice: null,
        note: `${decision.note} Exit skipped because TradeStation reports 0 long contracts for ${automation.optionSymbol}.`,
      });
      continue;
    }

    const exitQuantity = heldQuantity;
    if (numbersDiffer(trade.contracts, exitQuantity)) {
      await updateJournalTrade(trade.id, { contracts: exitQuantity });
    }

    const orderPlacement = await placeSellToCloseOrders({
      client,
      getExecutions: client.getExecutions,
      accountId: automation.accountId,
      optionSymbol: automation.optionSymbol,
      quantity: exitQuantity,
    });
    const orderIds = orderPlacement.orderIds.join(", ");
    if (orderPlacement.rejectedOrder) {
      decisionLog = appendDecisionLog(decisionLog, {
        timestamp: nowIso,
        tradeId: trade.id,
        symbol: trade.symbol,
        kind: "exit",
        action: "exit_rejected",
        reason: decision.reason,
        note: `${decision.note} ${formatRejectedOrderReason(orderPlacement.rejectedOrder)}`,
        optionSymbol: automation.optionSymbol,
        orderId: orderIds || orderPlacement.rejectedOrder.orderId,
        quantity: exitQuantity,
        currentUnderlyingPrice: underlyingQuote.last,
        currentOptionMid: optionQuote.mid,
      });
      await updateJournalTradeSignalSnapshot(
        trade.id,
        buildUpdatedSignalSnapshot(trade, { ...currentSnapshotUpdates, decisionLog }),
      );
      exitsTriggered.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: decision.reason,
        action: "skipped",
        orderId: orderIds || orderPlacement.rejectedOrder.orderId,
        optionExitPrice: null,
        note: `${decision.note} ${formatRejectedOrderReason(orderPlacement.rejectedOrder)}`,
      });
      continue;
    }

    let optionExitPrice = orderPlacement.averageFillPrice;
    if (optionExitPrice === null) {
      optionExitPrice =
        optionQuote.mid
        ?? optionQuote.bid
        ?? readNumber(trade.option_entry_price);
    }
    if (optionExitPrice === null || optionExitPrice <= 0) {
      decisionLog = appendDecisionLog(decisionLog, {
        timestamp: nowIso,
        tradeId: trade.id,
        symbol: trade.symbol,
        kind: "exit",
        action: "exit_price_missing",
        reason: decision.reason,
        note: `${decision.note} Exit order was sent, but no usable fill price was available for journaling.`,
        optionSymbol: automation.optionSymbol,
        orderId: orderIds || null,
        quantity: exitQuantity,
        currentUnderlyingPrice: underlyingQuote.last,
        currentOptionMid: optionQuote.mid,
      });
      await updateJournalTradeSignalSnapshot(
        trade.id,
        buildUpdatedSignalSnapshot(trade, { ...currentSnapshotUpdates, decisionLog }),
      );
      exitsTriggered.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: decision.reason,
        action: "skipped",
        orderId: orderIds || null,
        optionExitPrice: null,
        note: `${decision.note} Exit order was sent, but no usable fill price was available for journaling.`,
      });
      continue;
    }

    decisionLog = appendDecisionLog(decisionLog, {
      timestamp: nowIso,
      tradeId: trade.id,
      symbol: trade.symbol,
      kind: "exit",
      action: "closed",
      reason: decision.reason,
      note: decision.note,
      optionSymbol: automation.optionSymbol,
      orderId: orderIds || null,
      quantity: exitQuantity,
      positionCostUsd: readNumber(trade.position_cost_usd),
      currentUnderlyingPrice: underlyingQuote.last,
      currentOptionMid: optionQuote.mid,
    });
    await updateJournalTradeSignalSnapshot(
      trade.id,
      buildUpdatedSignalSnapshot(trade, { ...currentSnapshotUpdates, decisionLog }),
    );

    await closeJournalTrade(trade.id, {
      option_exit_price: optionExitPrice,
      exit_reason: decision.reason,
      exit_timestamp: nowIso,
      quantity_closed: exitQuantity,
      fees_usd: 0,
      slippage_usd: 0,
      exit_notes: `Paper trader auto-exit. ${decision.note}`,
      lessons_learned: null,
      review_notes: `Paper trader auto-managed exit from ${automation.optionSymbol}.`,
    });

    exitsTriggered.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      reason: decision.reason,
      action: "closed",
      orderId: orderIds || null,
      optionExitPrice,
      note: decision.note,
    });
  }

  return {
    inspected,
    updates,
    exitsTriggered,
    skipped,
  };
}

async function maybeEnterNewPaperTrade(params: {
  config: PaperTraderConfig;
  dryRun: boolean;
  allTrades: JournalTradeDetail[];
  openPaperTrades: JournalTradeDetail[];
  prompt: string;
}): Promise<PaperTraderRunResult["entry"]> {
  const {
    config,
    dryRun,
    allTrades,
    openPaperTrades,
    prompt,
  } = params;

  const entryRewardModel = trainEntryRewardModel(allTrades);
  const resumableScanState = await loadResumableAutomatedScanState(dryRun);
  const scanRunId = resumableScanState?.scanRunId ?? buildScanRunId();
  const paperLearningPreferences =
    resumableScanState?.paperLearningPreferences
    ?? buildPaperLearningPreferences(entryRewardModel);
  const openSymbols = openPaperTrades.map((trade) => trade.symbol);
  const policySkippedSymbols: string[] = [];
  const policySkipReasons: string[] = [];
  const evaluatedCandidates: PaperTraderEntryCandidateEvaluation[] = [];
  const automatedScan = await runAutomatedEntryScan({
    scanRunId,
    prompt,
    excludedTickers: openSymbols,
    tradestationBaseUrlOverride: config.automationBaseUrl,
    paperLearningPreferences,
    state: resumableScanState,
    onCandidate: async (candidate) => {
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: candidate.symbol,
        decision: candidate.decision,
        decisionReason: candidate.reason,
        scan: candidate.scan,
      });
    },
  });
  const entryScanSummary = {
    status: automatedScan.status,
    scannedSymbolCount: automatedScan.scannedSymbolCount,
    totalSymbolCount: automatedScan.totalSymbolCount,
    chunkCount: automatedScan.chunkCount,
    finalistCount: automatedScan.finalistCount,
    confirmedCandidateCount: automatedScan.confirmedCandidates.length,
    mlAdjustmentSummary: automatedScan.chunkSummaries
      .flatMap((chunk) => chunk.reason.match(/Paper learning[^.]+\./g) ?? [])
      .slice(0, 8),
  };
  if (!automatedScan.completed) {
    return {
      attempted: true,
      outcome: "scan_in_progress",
      symbol: automatedScan.confirmedCandidates[0]?.scan.ticker ?? null,
      reason: `Automated scan is in progress: scanned ${automatedScan.scannedSymbolCount}/${automatedScan.totalSymbolCount} symbols across ${automatedScan.chunkCount} chunk(s), with ${automatedScan.confirmedCandidates.length} confirmed candidate(s) stored so far. The next paper-trader run will resume from this point.`,
      evaluatedCandidates,
      scanSummary: entryScanSummary,
      automatedScanState: automatedScan.state,
    };
  }
  let selectedScan: Awaited<ReturnType<typeof runScan>> | null = null;
  let selectedTradeCard: TradeConstructionResult | null = null;
  let selectedEntryReasoning: PaperTraderEntryReasoning | null = null;
  let selectedEntryPolicy: EntryPolicyRecommendation | null = null;
  let selectedEntryFeatures: EntryRewardFeatureInput | null = null;

  for (const candidate of automatedScan.confirmedCandidates) {
    const scan = candidate.scan;
    const tradeCard = candidate.tradeCard;
    try {
      const entryFeatures = buildEntryRewardFeatureInput({
        scan,
        tradeCard,
        entryTimestamp: new Date(),
      });
      const geometryError = validateEntryGeometry(tradeCard);
      if (geometryError) {
        const symbol = scan.ticker ?? "unknown";
        policySkippedSymbols.push(symbol);
        policySkipReasons.push(`${symbol}: ${geometryError}`);
        evaluatedCandidates.push({
          symbol: scan.ticker,
          decision: "trade_card_blocked",
          reason: geometryError,
          entryPolicy: null,
          features: entryFeatures,
        });
        await recordEntryCandidateAudit({
          scanRunId,
          dryRun,
          symbol: scan.ticker,
          decision: "trade_card_blocked",
          decisionReason: geometryError,
          features: entryFeatures,
          entryPolicy: null,
          scan,
          tradeCard,
        });
        continue;
      }
      const entryPolicy = recommendEntryPolicy(
        entryRewardModel,
        entryFeatures,
      );

      if (entryPolicy.decision === "block") {
        const decisionReason = entryPolicy.summary;
        const symbol = scan.ticker ?? "unknown";
        policySkippedSymbols.push(symbol);
        policySkipReasons.push(`${symbol}: ${decisionReason}`);
        evaluatedCandidates.push({
          symbol: scan.ticker,
          decision: "policy_blocked",
          reason: decisionReason,
          entryPolicy,
          features: entryFeatures,
        });
        await recordEntryCandidateAudit({
          scanRunId,
          dryRun,
          symbol: scan.ticker,
          decision: "policy_blocked",
          decisionReason,
          features: entryFeatures,
          entryPolicy,
          scan,
          tradeCard,
        });
        continue;
      }

      selectedScan = scan;
      selectedTradeCard = tradeCard;
      selectedEntryReasoning = buildEntryReasoning(scan, tradeCard);
      selectedEntryPolicy = entryPolicy;
      selectedEntryFeatures = entryFeatures;
      evaluatedCandidates.push({
        symbol: scan.ticker,
        decision: entryPolicy.decision,
        reason: entryPolicy.summary,
        entryPolicy,
        features: entryFeatures,
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Trade construction failed.";
      policySkippedSymbols.push(scan.ticker ?? "unknown");
      policySkipReasons.push(`${scan.ticker ?? "unknown"}: ${message}`);
      evaluatedCandidates.push({
        symbol: scan.ticker,
        decision: "trade_card_blocked",
        reason: message,
        entryPolicy: null,
        features: null,
      });
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "trade_card_blocked",
        decisionReason: message,
        scan,
      });
      continue;
    }
  }

  if (!selectedScan || !selectedTradeCard || !selectedEntryReasoning || !selectedEntryPolicy || !selectedEntryFeatures) {
    const scanSummary = `Scanned ${automatedScan.scannedSymbolCount}/${automatedScan.totalSymbolCount} symbols across ${automatedScan.chunkCount} chunk(s), ranked ${automatedScan.finalistCount} finalist row(s), confirmed ${automatedScan.confirmedCandidates.length} trade-card-ready candidate(s).`;
    return {
      attempted: true,
      outcome: "no_trade_today",
      symbol: policySkippedSymbols.at(-1) ?? null,
      reason: `${scanSummary} No eligible entry survived final automation policy/risk checks: ${policySkipReasons.join(" ") || "no confirmed candidate survived the full scan."}`,
      evaluatedCandidates,
      scanSummary: entryScanSummary,
    };
  }

  const scan = selectedScan;
  const tradeCard = selectedTradeCard;
  const entryReasoning = selectedEntryReasoning;
  const entryPolicyRecommendation = selectedEntryPolicy;
  const entryFeatures = selectedEntryFeatures;

  try {
    const automation = tradeCard.automationMetadata;
    if (automation.contracts < 1) {
      const reason = `Trade card sized ${automation.contracts} contracts, so the paper trader skipped the entry.`;
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "zero_contract_trade",
        decisionReason: reason,
        features: entryFeatures,
        entryPolicy: entryPolicyRecommendation,
        selected: true,
        scan,
        tradeCard,
      });
      return {
        attempted: true,
        outcome: "zero_contract_trade",
        symbol: scan.ticker,
        reason,
        tradeCard,
        reasoning: entryReasoning,
        evaluatedCandidates,
        scanSummary: entryScanSummary,
      };
    }
    const duplicateOpenTrade = openPaperTrades.find((trade) => {
      const existingAutomation = readAutomationSnapshot(trade);
      return trade.symbol === scan.ticker || existingAutomation?.optionSymbol === automation.optionSymbol;
    });
    if (duplicateOpenTrade) {
      const reason = `Duplicate-entry guard blocked ${scan.ticker}; an open paper trade already exists for ${duplicateOpenTrade.symbol}.`;
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "duplicate_position_blocked",
        decisionReason: reason,
        features: entryFeatures,
        entryPolicy: entryPolicyRecommendation,
        selected: true,
        scan,
        tradeCard,
      });
      return {
        attempted: true,
        outcome: "trade_card_blocked",
        symbol: scan.ticker,
        reason,
        tradeCard,
        reasoning: entryReasoning,
        evaluatedCandidates,
        scanSummary: entryScanSummary,
      };
    }

    const geometryError = validateEntryGeometry(tradeCard);
    if (geometryError) {
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "trade_card_blocked",
        decisionReason: geometryError,
        features: entryFeatures,
        entryPolicy: entryPolicyRecommendation,
        selected: true,
        scan,
        tradeCard,
      });
      return {
        attempted: true,
        outcome: "trade_card_blocked",
        symbol: scan.ticker,
        reason: geometryError,
        tradeCard,
        reasoning: entryReasoning,
        evaluatedCandidates,
        scanSummary: entryScanSummary,
      };
    }

    const client = await createAutomationTradeStationClient(config.automationBaseUrl);
    const entryLimitPrice = normalizeTradeStationOrderPrice({
      symbol: automation.optionSymbol,
      price: automation.optionLimitPrice,
      tradeAction: automation.entryTradeAction,
    });
    let accountValueUsd: number | null = null;
    let entryBuyingPowerUsd: number | null = null;
    try {
      const balancesPayload = await client.getBalances(config.accountId as string);
      accountValueUsd = extractAccountValue(balancesPayload);
      entryBuyingPowerUsd = extractEntryBuyingPower(balancesPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = `Could not enforce the ${(config.maxPositionPct * 100).toFixed(0)}% account-value cap from TradeStation balances, so the paper trader skipped the entry. ${message}`;
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "balance_read_failed",
        decisionReason: reason,
        features: entryFeatures,
        entryPolicy: entryPolicyRecommendation,
        selected: true,
        scan,
        tradeCard,
      });
      return {
        attempted: true,
        outcome: "trade_card_blocked",
        symbol: scan.ticker,
        reason,
        tradeCard,
        reasoning: entryReasoning,
        evaluatedCandidates,
        scanSummary: entryScanSummary,
      };
    }
    if (accountValueUsd === null || accountValueUsd <= 0) {
      const reason = "Could not read a positive SIM account value from TradeStation balances, so the paper trader skipped the entry instead of risking an oversized position.";
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "balance_missing",
        decisionReason: reason,
        features: entryFeatures,
        entryPolicy: entryPolicyRecommendation,
        selected: true,
        scan,
        tradeCard,
      });
      return {
        attempted: true,
        outcome: "trade_card_blocked",
        symbol: scan.ticker,
        reason,
        tradeCard,
        reasoning: entryReasoning,
        evaluatedCandidates,
        scanSummary: entryScanSummary,
      };
    }

    const positionCap = computePositionCap({
      requestedContracts: automation.contracts,
      limitPrice: entryLimitPrice,
      accountValueUsd,
      entryBuyingPowerUsd,
      maxPositionPct: config.maxPositionPct,
    });
    if (positionCap.cappedContracts < 1) {
      const capParts = [
        `${(config.maxPositionPct * 100).toFixed(0)}% account-value cap allows $${positionCap.maxPositionCostUsd.toFixed(2)}`,
        positionCap.entryBuyingPowerUsd !== null
          ? `available SIM buying power allows $${positionCap.entryBuyingPowerUsd.toFixed(2)}`
          : null,
      ].filter(Boolean);
      const reason = `${capParts.join(" and ")}, which is below one ${automation.optionSymbol} contract at ${entryLimitPrice.toFixed(2)}.`;
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "position_cap_blocked",
        decisionReason: reason,
        features: entryFeatures,
        entryPolicy: entryPolicyRecommendation,
        selected: true,
        scan,
        tradeCard,
      });
      return {
        attempted: true,
        outcome: "zero_contract_trade",
        symbol: scan.ticker,
        reason,
        tradeCard,
        reasoning: entryReasoning,
        evaluatedCandidates,
        scanSummary: entryScanSummary,
      };
    }

    const cappedContracts = positionCap.cappedContracts;
    const positionScale = cappedContracts / automation.contracts;
    const cappedPlannedJournalFields = {
      ...tradeCard.plannedJournalFields,
      position_cost_usd: positionCap.cappedPositionCostUsd,
      planned_risk_usd: Number((tradeCard.plannedJournalFields.planned_risk_usd * positionScale).toFixed(2)),
      planned_profit_usd: Number((tradeCard.plannedJournalFields.planned_profit_usd * positionScale).toFixed(2)),
      market_regime: entryFeatures.marketRegime,
    };
    const capReasons = [
      cappedContracts < automation.contracts && cappedContracts === MAX_TRADESTATION_CONTRACTS_PER_ORDER
        ? `TradeStation's ${MAX_TRADESTATION_CONTRACTS_PER_ORDER}-contract per-order cap`
        : null,
      cappedContracts < automation.contracts && cappedContracts < MAX_TRADESTATION_CONTRACTS_PER_ORDER
        && positionCap.effectiveMaxPositionCostUsd >= positionCap.maxPositionCostUsd
        ? `${(config.maxPositionPct * 100).toFixed(0)}% account-value cap`
        : null,
      cappedContracts < automation.contracts && positionCap.entryBuyingPowerUsd !== null
        && positionCap.entryBuyingPowerUsd <= positionCap.maxPositionCostUsd
        ? "available SIM buying power"
        : null,
    ].filter(Boolean);
    const capNote = cappedContracts < automation.contracts
      ? ` Size reduced from ${automation.contracts} to ${cappedContracts} contracts by ${capReasons.join(" and ")}.`
      : "";
    const entryOrder: TradeStationOrderRequest = {
      accountId: config.accountId as string,
      symbol: automation.optionSymbol,
      quantity: cappedContracts,
      orderType: automation.entryOrderType,
      tradeAction: automation.entryTradeAction,
      limitPrice: entryLimitPrice,
      duration: "DAY",
    };
    const confirmation = await client.confirmOrder(entryOrder);
    if (isRejectedOrderResult(confirmation)) {
      const reason = formatRejectedOrderReason(confirmation);
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "confirmation_rejected",
        decisionReason: reason,
        features: entryFeatures,
        entryPolicy: entryPolicyRecommendation,
        selected: true,
        scan,
        tradeCard,
      });
      return {
        attempted: true,
        outcome: "trade_card_blocked",
        symbol: scan.ticker,
        reason,
        tradeCard,
        reasoning: entryReasoning,
        evaluatedCandidates,
        scanSummary: entryScanSummary,
      };
    }

    if (dryRun) {
      const reason = `Previewed ${cappedContracts}x ${automation.optionSymbol} at ${entryLimitPrice.toFixed(2)} without sending the order.${capNote} Entry policy: ${entryPolicyRecommendation.summary}`;
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "preview_only",
        decisionReason: reason,
        features: entryFeatures,
        entryPolicy: entryPolicyRecommendation,
        selected: true,
        scan,
        tradeCard,
      });
      return {
        attempted: true,
        outcome: "preview_only",
        symbol: scan.ticker,
        reason,
        tradeCard,
        reasoning: entryReasoning,
        evaluatedCandidates,
        scanSummary: entryScanSummary,
      };
    }

    const orderResult = await client.placeOrder(entryOrder);
    if (isRejectedOrderResult(orderResult)) {
      const reason = formatRejectedOrderReason(orderResult);
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "order_rejected",
        decisionReason: reason,
        orderId: orderResult.orderId,
        features: entryFeatures,
        entryPolicy: entryPolicyRecommendation,
        selected: true,
        scan,
        tradeCard,
      });
      return {
        attempted: true,
        outcome: "trade_card_blocked",
        symbol: scan.ticker,
        reason,
        tradeCard,
        reasoning: entryReasoning,
        evaluatedCandidates,
        scanSummary: entryScanSummary,
      };
    }

    let optionEntryPrice = orderResult.averageFillPrice ?? entryLimitPrice;
    if (orderResult.orderId) {
      optionEntryPrice = (
        await getAverageFillPriceIfAvailable({
          getExecutions: client.getExecutions,
          accountId: config.accountId as string,
          orderId: orderResult.orderId,
        })
      ) ?? optionEntryPrice;
    }

    const now = new Date();
    const chicagoNow = formatChicagoParts(now);
    const presentationSummary = buildWorkflowPresentationSummary({
      scan,
      telemetry: scan.telemetry ?? null,
      tradeCard,
    });
    const entryPolicyModelSummary = summarizeEntryRewardModel(entryRewardModel);
    const entryDecisionLog: PaperTraderDecisionLogEntry[] = [{
      timestamp: now.toISOString(),
      symbol: scan.ticker,
      kind: "entry",
      action: "entered_paper_trade",
      outcome: "entered_paper_trade",
      note: `AI selected ${scan.ticker} and entered ${cappedContracts}x ${automation.optionSymbol}.${capNote} Entry policy: ${entryPolicyRecommendation.summary}`,
      thesis: entryReasoning.whyThisWon ?? entryReasoning.tradeRationale,
      plainEnglishExplanation: entryReasoning.conciseReasoning,
      optionSymbol: automation.optionSymbol,
      orderId: orderResult.orderId,
      quantity: cappedContracts,
      positionCostUsd: Number((cappedContracts * optionEntryPrice * 100).toFixed(2)),
      accountValueUsd,
      maxPositionCostUsd: positionCap.maxPositionCostUsd,
      positionPct: accountValueUsd > 0
        ? Number(((cappedContracts * optionEntryPrice * 100) / accountValueUsd).toFixed(4))
        : positionCap.positionPct,
      stopUnderlying: automation.intendedStopUnderlying,
      targetUnderlying: automation.intendedTargetUnderlying,
      reasoning: entryReasoning,
      entryPolicy: entryPolicyRecommendation,
    }];

    const createdTrade = await createJournalTrade({
      account_mode: "paper",
      entry_date: chicagoNow.date,
      entry_time: chicagoNow.time,
      contracts: cappedContracts,
      option_entry_price: optionEntryPrice,
      entry_notes: "Entered automatically by paper trader module.",
      planned_trade: {
        ...cappedPlannedJournalFields,
        scan_run_id: scanRunId,
      },
      signal_snapshot_json: {
        paperTraderCompact: true,
        selectedScan: {
          ticker: scan.ticker,
          direction: scan.direction,
          confidence: scan.confidence,
          conclusion: scan.conclusion,
          reason: scan.reason,
        },
        presentationSummary,
        entryFeatures,
        tradeCardSummary: {
          ticker: tradeCard.ticker,
          direction: tradeCard.direction,
          buy: tradeCard.buy,
          rationale: tradeCard.rationale,
          rrMath: tradeCard.rrMath,
          expectedTiming: tradeCard.expectedTiming,
          invalidationExit: tradeCard.invalidationExit,
          takeProfitExit: tradeCard.takeProfitExit,
          timeExit: tradeCard.timeExit,
        },
        automation: {
          lane: "paper_trader_v1",
          paperTrader: {
            accountId: config.accountId,
            optionSymbol: automation.optionSymbol,
            quantity: cappedContracts,
            requestedQuantity: cappedContracts,
            entryOrderType: automation.entryOrderType,
            entryTradeAction: automation.entryTradeAction,
            entryLimitPrice,
            intendedStopUnderlying: automation.intendedStopUnderlying,
            intendedTargetUnderlying: automation.intendedTargetUnderlying,
            activeStopUnderlying: automation.intendedStopUnderlying,
            activeTargetUnderlying: automation.intendedTargetUnderlying,
            timeExitDate: automation.timeExitDate,
            orderId: orderResult.orderId,
            managementStyle: "ai",
            lastManagementAction: "hold",
            lastManagementConfidence: "medium",
            lastManagementNote: "Trade entered. AI manager is waiting for the next review cycle.",
            lastManagementThesis: "Original thesis accepted at entry.",
            lastManagementAt: now.toISOString(),
            managementHistory: [],
            decisionLog: entryDecisionLog,
            entryReasoning,
            entryFeatures,
            entryPolicyRecommendation,
            entryPolicyModelSummary,
            accountValueAtEntry: accountValueUsd,
            maxPositionPct: config.maxPositionPct,
            maxPositionCostUsd: positionCap.maxPositionCostUsd,
            positionPctAtEntry: entryDecisionLog[0]?.positionPct ?? null,
            confirmationStatus: confirmation.status,
            orderStatus: orderResult.status,
          },
        },
      },
      status: "open",
    });

    const enteredReason = `Entered ${cappedContracts}x ${automation.optionSymbol} in the paper account.${capNote} Entry policy: ${entryPolicyRecommendation.summary}`;
    await recordEntryCandidateAudit({
      scanRunId,
      dryRun,
      symbol: scan.ticker,
      decision: "entered_paper_trade",
      decisionReason: enteredReason,
      paperTradeId: createdTrade.id,
      orderId: orderResult.orderId,
      features: entryFeatures,
      entryPolicy: entryPolicyRecommendation,
      selected: true,
      scan,
      tradeCard,
    });

    return {
      attempted: true,
      outcome: "entered_paper_trade",
      symbol: scan.ticker,
      reason: enteredReason,
      orderId: orderResult.orderId,
      journalTradeId: createdTrade.id,
      tradeCard,
      reasoning: entryReasoning,
      evaluatedCandidates,
      scanSummary: entryScanSummary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trade construction failed.";
    await recordEntryCandidateAudit({
      scanRunId,
      dryRun,
      symbol: scan.ticker,
      decision: "entry_failed",
      decisionReason: message,
      features: entryFeatures,
      entryPolicy: entryPolicyRecommendation,
      selected: true,
      scan,
      tradeCard,
    });
    return {
      attempted: true,
      outcome: "trade_card_blocked",
      symbol: scan.ticker,
      reason: message,
      reasoning: buildEntryReasoning(scan, null),
      evaluatedCandidates,
      scanSummary: entryScanSummary,
    };
  }
}

export async function runPaperTraderCycle(
  options: PaperTraderRunOptions = {},
): Promise<PaperTraderRunResult> {
  const config = readPaperTraderConfig();
  assertPaperTraderConfig(config);

  const requestedDryRun = options.dryRun === true;
  const dryRun = config.allowOrderPlacement
    ? requestedDryRun
    : true;
  const dryRunReason = dryRun
    ? options.reconcileOnly
      ? "Monitor-only run uses read-only TradeStation checks and does not place orders."
      : requestedDryRun
      ? "Dry run was requested explicitly."
      : "AUTO_TRADER_ALLOW_ORDER_PLACEMENT is not enabled, so this run used preview-only mode."
    : null;
  let allTrades = await loadPaperTraderCycleTrades();
  const shouldReconcileOrders = options.reconcileOrders === true || !dryRun;
  const reconciliation = await reconcileOpenPaperOrders(
    config,
    allTrades,
    shouldReconcileOrders,
  );
  if (reconciliation.updated > 0) {
    allTrades = await loadPaperTraderCycleTrades();
  }

  const openPaperTrades = allTrades.filter(
    (trade) => trade.account_mode === "paper" && trade.status === "open",
  );
  const chicagoNow = formatChicagoParts(new Date());
  const todayChicago = chicagoNow.date;
  const todayRealizedPlUsd = computeTodayRealizedPlUsd(allTrades, todayChicago);

  const includeHistory = options.includeHistory !== false;

  if (options.reconcileOnly) {
    return await finalizePaperTraderRunResult({
      mode: "paper",
      timestamp: new Date().toISOString(),
      dryRun,
      dryRunReason,
      config: {
        automationBaseUrl: config.automationBaseUrl,
        allowOrderPlacement: config.allowOrderPlacement,
        accountId: config.accountId as string,
        maxOpenTrades: config.maxOpenTrades,
        maxDailyLossUsd: config.maxDailyLossUsd,
        maxPositionPct: config.maxPositionPct,
      },
      guards: {
        openPaperTrades: openPaperTrades.length,
        liveSimPositions: null,
        staleOpenJournalTrades: reconciliation.staleArchived,
        todayRealizedPlUsd,
        newEntriesAllowed: false,
      },
      reconciliation,
      management: {
        inspected: 0,
        updates: [],
        exitsTriggered: [],
        skipped: [],
      },
      entry: {
        attempted: false,
        outcome: "monitor_only",
        symbol: null,
        reason: "Monitor-only run reconciled open paper orders and skipped AI exits plus new entries.",
      },
    }, allTrades, includeHistory);
  }

  if (!dryRun && !isRegularUsEquitySession(new Date())) {
    return await finalizePaperTraderRunResult({
      mode: "paper",
      timestamp: new Date().toISOString(),
      dryRun,
      dryRunReason,
      config: {
        automationBaseUrl: config.automationBaseUrl,
        allowOrderPlacement: config.allowOrderPlacement,
        accountId: config.accountId as string,
        maxOpenTrades: config.maxOpenTrades,
        maxDailyLossUsd: config.maxDailyLossUsd,
        maxPositionPct: config.maxPositionPct,
      },
      guards: {
        openPaperTrades: openPaperTrades.length,
        liveSimPositions: null,
        staleOpenJournalTrades: reconciliation.staleArchived,
        todayRealizedPlUsd,
        newEntriesAllowed: false,
      },
      reconciliation,
      management: {
        inspected: 0,
        updates: [],
        exitsTriggered: [],
        skipped: [],
      },
      entry: {
        attempted: false,
        outcome: "outside_market_hours",
        symbol: null,
        reason: `Skipped live paper-trader cycle outside regular US equity market hours (America/Chicago). Current Chicago time: ${chicagoNow.time}.`,
      },
    }, allTrades, includeHistory);
  }

  const management = await manageOpenPaperTrades(config, dryRun, allTrades);
  const remainingOpenPaperTrades = openPaperTrades.filter(
    (trade) =>
      !management.exitsTriggered.some(
        (exit) => exit.tradeId === trade.id && exit.action === "closed",
      ),
  );
  const entry = options.skipNewEntry
      ? {
        attempted: false,
        outcome: "monitor_only" as const,
        symbol: null,
        reason: "This run skipped new entries by request.",
      }
    : await maybeEnterNewPaperTrade({
        config,
        dryRun,
        allTrades,
        openPaperTrades: remainingOpenPaperTrades,
        prompt: options.prompt ?? config.scanPrompt,
      });

  const decisionLogTrades = !dryRun || reconciliation.updated > 0
    ? await loadPaperTraderCycleTrades()
    : allTrades;

  return await finalizePaperTraderRunResult({
    mode: "paper",
    timestamp: new Date().toISOString(),
    dryRun,
    dryRunReason,
    config: {
      automationBaseUrl: config.automationBaseUrl,
      allowOrderPlacement: config.allowOrderPlacement,
      accountId: config.accountId as string,
      maxOpenTrades: config.maxOpenTrades,
      maxDailyLossUsd: config.maxDailyLossUsd,
      maxPositionPct: config.maxPositionPct,
    },
    guards: {
      openPaperTrades: remainingOpenPaperTrades.length,
      liveSimPositions: null,
      staleOpenJournalTrades: reconciliation.staleArchived,
      todayRealizedPlUsd,
      newEntriesAllowed: true,
    },
    reconciliation,
    management,
    entry,
  }, decisionLogTrades, includeHistory);
}
