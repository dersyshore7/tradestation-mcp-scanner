import { buildWorkflowPresentationSummary } from "../app/resultPresentation.js";
import {
  extractFinalizedTradeGeometryFromTelemetry,
  runScan,
} from "../app/runScan.js";
import {
  constructTradeCard,
  type TradeConstructionResult,
} from "../app/runTradeConstruction.js";
import {
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
} from "./tradestation.js";
import {
  listRecentPaperTraderRuns,
  recordPaperTraderRun,
  type PaperTraderRunRecord,
} from "./paperTraderHistory.js";

const MAX_ENTRY_POLICY_SCAN_ATTEMPTS = 3;
const MAX_TRADESTATION_CONTRACTS_PER_ORDER = 2000;

type PaperTraderRunOptions = {
  prompt?: string;
  dryRun?: boolean;
  source?: "api" | "cli";
  reconcileOnly?: boolean;
  reconcileOrders?: boolean;
  skipNewEntry?: boolean;
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
    todayRealizedPlUsd: number;
    newEntriesAllowed: boolean;
  };
  reconciliation: {
    inspected: number;
    updated: number;
    partialFills: number;
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

function validateEntryGeometry(tradeCard: TradeConstructionResult): string | null {
  const fields = tradeCard.plannedJournalFields;
  const entry = readNumber(fields.underlying_entry_price);
  const stop = readNumber(fields.intended_stop_underlying);
  const target = readNumber(fields.intended_target_underlying);

  if (entry === null || stop === null || target === null) {
    return "Trade card is missing entry, stop, or target geometry.";
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

  if (!config.enabled) {
    issues.push("Set AUTO_TRADER_ENABLED=1 to enable the paper trader module.");
  }

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
      trades: await listJournalTradeDetails(250, { includeSignalSnapshot: false }),
      warning: null,
    };
  } catch (error) {
    return {
      trades: [],
      warning: formatNonCriticalHistoryError("Compact journal dashboard rows", error),
    };
  }
}

async function loadPaperTraderRunHistory(): Promise<{
  runHistory: PaperTraderRunRecord[];
  runHistoryMigrationRequired: boolean;
  runHistoryMigrationMessage: string | null;
}> {
  try {
    const runHistoryResult = await listRecentPaperTraderRuns(500);
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

async function loadPaperEntryCandidateHistory(): Promise<{
  entryCandidateHistory: PaperEntryCandidateRecord[];
  entryCandidateHistoryMigrationRequired: boolean;
  entryCandidateHistoryMigrationMessage: string | null;
}> {
  try {
    const result = await listRecentPaperEntryCandidates(200);
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

function computePositionCap(params: {
  requestedContracts: number;
  limitPrice: number;
  accountValueUsd: number;
  maxPositionPct: number;
}): {
  cappedContracts: number;
  cappedPositionCostUsd: number;
  maxPositionCostUsd: number;
  positionPct: number | null;
} {
  const maxPositionCostUsd = params.accountValueUsd * params.maxPositionPct;
  const maxContractsByCap = Math.floor(maxPositionCostUsd / (params.limitPrice * 100));
  const cappedContracts = Math.max(
    0,
    Math.min(params.requestedContracts, maxContractsByCap, MAX_TRADESTATION_CONTRACTS_PER_ORDER),
  );
  const cappedPositionCostUsd = Number((cappedContracts * params.limitPrice * 100).toFixed(2));

  return {
    cappedContracts,
    cappedPositionCostUsd,
    maxPositionCostUsd: Number(maxPositionCostUsd.toFixed(2)),
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
  return typeof tradeCard?.rationale === "string" ? tradeCard.rationale : null;
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

  const runHistory = await loadPaperTraderRunHistory();
  const entryCandidateHistory = await loadPaperEntryCandidateHistory();
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
  const entryCandidateHistory = await loadPaperEntryCandidateHistory();
  const sizing = await loadPaperTraderSizingSnapshot(config);

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
    openPaperTrades: trades.filter(
      (trade) => trade.account_mode === "paper" && trade.status === "open",
    ).length,
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

function numbersDiffer(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left !== right;
  }
  return Math.abs(left - right) > 0.0001;
}

async function reconcileOpenPaperOrders(
  config: PaperTraderConfig,
  allTrades: JournalTradeDetail[],
  updateJournal: boolean,
): Promise<PaperTraderRunResult["reconciliation"]> {
  const openPaperTrades = allTrades.filter(
    (trade) => trade.account_mode === "paper" && trade.status === "open",
  );
  if (openPaperTrades.length === 0) {
    return {
      inspected: 0,
      updated: 0,
      partialFills: 0,
      updates: [],
      skipped: [],
    };
  }

  const client = await createAutomationTradeStationClient(config.automationBaseUrl);
  const positionPayloads = new Map<string, unknown>();
  const updates: PaperTraderRunResult["reconciliation"]["updates"] = [];
  const skipped: PaperTraderRunResult["reconciliation"]["skipped"] = [];
  let updated = 0;
  let partialFills = 0;

  for (const trade of openPaperTrades) {
    const automation = readAutomationSnapshot(trade);
    if (!automation?.accountId || !automation.optionSymbol || !automation.orderId) {
      skipped.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: "Missing paper-trader order metadata for reconciliation.",
      });
      continue;
    }

    const requestedQuantity = readAutomationQuantity(trade, automation);
    let executionFilledQuantity: number | null = null;
    let executionAveragePrice: number | null = null;
    let orderCheckError: string | null = null;

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
          orderId: automation.orderId,
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
      await updateJournalTradeSignalSnapshot(
        trade.id,
        buildUpdatedSignalSnapshot(trade, snapshotUpdates),
      );

      if (
        filledQuantity !== null
        && filledQuantity > 0
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
      updated += 1;
    }

    updates.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      orderId: automation.orderId,
      fillStatus,
      filledQuantity,
      requestedQuantity,
      remainingQuantity,
      averageFillPrice,
      note: orderCheckError
        ? `Order check warning: ${orderCheckError}`
        : `Reconciled ${automation.optionSymbol}: ${fillStatus}.`,
    });
  }

  return {
    inspected: openPaperTrades.length,
    updated,
    partialFills,
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
    inspected: openPaperTrades.length,
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

  const scanRunId = buildScanRunId();
  const entryRewardModel = trainEntryRewardModel(allTrades);
  const openSymbols = openPaperTrades.map((trade) => trade.symbol);
  const policySkippedSymbols: string[] = [];
  const policySkipReasons: string[] = [];
  const evaluatedCandidates: PaperTraderEntryCandidateEvaluation[] = [];
  let selectedScan: Awaited<ReturnType<typeof runScan>> | null = null;
  let selectedTradeCard: TradeConstructionResult | null = null;
  let selectedEntryReasoning: PaperTraderEntryReasoning | null = null;
  let selectedEntryPolicy: EntryPolicyRecommendation | null = null;
  let selectedEntryFeatures: EntryRewardFeatureInput | null = null;

  for (let attempt = 0; attempt < MAX_ENTRY_POLICY_SCAN_ATTEMPTS; attempt += 1) {
    const scan = await runScan({
      prompt,
      excludedTickers: [...openSymbols, ...policySkippedSymbols],
      tradestationBaseUrlOverride: config.automationBaseUrl,
    });

    if (
      scan.conclusion !== "confirmed"
      || !scan.ticker
      || !scan.direction
      || !scan.confidence
    ) {
      const skippedNote = policySkipReasons.length > 0
        ? ` Entry reward policy skipped earlier candidate(s): ${policySkipReasons.join(" ")}`
        : "";
      return {
        attempted: true,
        outcome: "no_trade_today",
        symbol: scan.ticker,
        reason: `${scan.reason}${skippedNote}`,
        reasoning: buildEntryReasoning(scan, null),
        evaluatedCandidates,
      };
    }

    try {
      const finalizedTradeGeometry = extractFinalizedTradeGeometryFromTelemetry(
        scan.telemetry,
        scan.ticker,
      );
      const tradeCard = await constructTradeCard({
        prompt: `build trade ${scan.ticker}`,
        confirmedDirection: scan.direction,
        confirmedConfidence: scan.confidence,
        ...(finalizedTradeGeometry ? { finalizedTradeGeometry } : {}),
        tradestationBaseUrlOverride: config.automationBaseUrl,
      });
      const entryFeatures = buildEntryRewardFeatureInput({
        scan,
        tradeCard,
        entryTimestamp: new Date(),
      });
      const entryPolicy = recommendEntryPolicy(
        entryRewardModel,
        entryFeatures,
      );

      if (entryPolicy.decision === "block") {
        const decisionReason = entryPolicy.summary;
        policySkippedSymbols.push(scan.ticker);
        policySkipReasons.push(`${scan.ticker}: ${decisionReason}`);
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
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "trade_card_blocked",
        decisionReason: message,
        scan,
      });
      return {
        attempted: true,
        outcome: "trade_card_blocked",
        symbol: scan.ticker,
        reason: message,
        reasoning: buildEntryReasoning(scan, null),
        evaluatedCandidates,
      };
    }
  }

  if (!selectedScan || !selectedTradeCard || !selectedEntryReasoning || !selectedEntryPolicy || !selectedEntryFeatures) {
    return {
      attempted: true,
      outcome: "trade_card_blocked",
      symbol: policySkippedSymbols.at(-1) ?? null,
      reason: `Entry reward policy blocked ${policySkippedSymbols.length} candidate(s) after ${MAX_ENTRY_POLICY_SCAN_ATTEMPTS} scan attempt(s): ${policySkipReasons.join(" ")}`,
      evaluatedCandidates,
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
      };
    }

    const client = await createAutomationTradeStationClient(config.automationBaseUrl);
    const entryLimitPrice = normalizeTradeStationOrderPrice({
      symbol: automation.optionSymbol,
      price: automation.optionLimitPrice,
      tradeAction: automation.entryTradeAction,
    });
    let accountValueUsd: number | null = null;
    try {
      accountValueUsd = extractAccountValue(await client.getBalances(config.accountId as string));
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
      };
    }

    const positionCap = computePositionCap({
      requestedContracts: automation.contracts,
      limitPrice: entryLimitPrice,
      accountValueUsd,
      maxPositionPct: config.maxPositionPct,
    });
    if (positionCap.cappedContracts < 1) {
      const reason = `The ${(config.maxPositionPct * 100).toFixed(0)}% account-value cap allows ${positionCap.maxPositionCostUsd.toFixed(2)} of buying power, which is below one ${automation.optionSymbol} contract at ${entryLimitPrice.toFixed(2)}.`;
      await recordEntryCandidateAudit({
        scanRunId,
        dryRun,
        symbol: scan.ticker,
        decision: "position_cap_blocked",
        decisionReason: reason,
        features: entryFeatures,
        entryPolicy: entryPolicyRecommendation,
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
      };
    }

    const cappedContracts = positionCap.cappedContracts;
    const positionScale = cappedContracts / automation.contracts;
    const cappedPlannedJournalFields = {
      ...tradeCard.plannedJournalFields,
      position_cost_usd: positionCap.cappedPositionCostUsd,
      planned_risk_usd: Number((tradeCard.plannedJournalFields.planned_risk_usd * positionScale).toFixed(2)),
      planned_profit_usd: Number((tradeCard.plannedJournalFields.planned_profit_usd * positionScale).toFixed(2)),
    };
    const capReasons = [
      cappedContracts < automation.contracts && cappedContracts === MAX_TRADESTATION_CONTRACTS_PER_ORDER
        ? `TradeStation's ${MAX_TRADESTATION_CONTRACTS_PER_ORDER}-contract per-order cap`
        : null,
      cappedContracts < automation.contracts && cappedContracts < MAX_TRADESTATION_CONTRACTS_PER_ORDER
        ? `${(config.maxPositionPct * 100).toFixed(0)}% account-value cap`
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
        scan,
        telemetry: scan.telemetry ?? null,
        presentationSummary,
        tradeCard,
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
  let allTrades = await listJournalTradeDetails(500, { accountMode: "paper" });
  const shouldReconcileOrders = options.reconcileOrders === true || !dryRun;
  const reconciliation = await reconcileOpenPaperOrders(
    config,
    allTrades,
    shouldReconcileOrders,
  );
  if (reconciliation.updated > 0) {
    allTrades = await listJournalTradeDetails(500, { accountMode: "paper" });
  }

  const openPaperTrades = allTrades.filter(
    (trade) => trade.account_mode === "paper" && trade.status === "open",
  );
  const chicagoNow = formatChicagoParts(new Date());
  const todayChicago = chicagoNow.date;
  const todayRealizedPlUsd = computeTodayRealizedPlUsd(allTrades, todayChicago);

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
    }, allTrades);
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
    }, allTrades);
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
    ? await listJournalTradeDetails(500, { accountMode: "paper" })
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
      todayRealizedPlUsd,
      newEntriesAllowed: true,
    },
    reconciliation,
    management,
    entry,
  }, decisionLogTrades);
}
