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
  createAutomationTradeStationClient,
  extractAverageFillPrice,
  findPositionSnapshot,
  normalizeTradeStationOrderPrice,
  summarizeExecutions,
  type TradeStationOrderRequest,
} from "./tradestation.js";

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

type PaperTraderAutomationSnapshot = NonNullable<
  NonNullable<AutomationSnapshot["automation"]>["paperTrader"]
>;

type ExitDecision = {
  reason: "target_hit" | "stop_hit" | "time_exit" | "manual_early_exit";
  note: string;
};

type PaperTraderStatus = {
  enabled: boolean;
  allowOrderPlacement: boolean;
  liveRunReady: boolean;
  automationBaseUrl: string;
  accountIdConfigured: boolean;
  maxOpenTrades: number;
  maxDailyLossUsd: number;
  requiresSecret: boolean;
  openPaperTrades: number;
  configurationIssues: string[];
  learning: {
    closedPaperTrades: number;
    managementExperiences: number;
    learnedContexts: number;
    readyForPolicyPrior: boolean;
  };
};

type PaperTraderEntryReasoning = {
  conciseReasoning: string | null;
  whyThisWon: string | null;
  tradeRationale: string | null;
  optionChosen: string | null;
  chartGeometry: Record<string, unknown> | null;
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
    maxOpenTrades: number;
    maxDailyLossUsd: number;
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
  };
};

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

export async function getPaperTraderStatus(): Promise<PaperTraderStatus> {
  const config = readPaperTraderConfig();
  const trades = await listJournalTradeDetails(200);
  const configurationIssues = buildPaperTraderConfigurationIssues(config);
  const policyModel = trainPolicyModel(trades);

  return {
    enabled: config.enabled,
    allowOrderPlacement: config.allowOrderPlacement,
    liveRunReady: configurationIssues.length === 0,
    automationBaseUrl: config.automationBaseUrl,
    accountIdConfigured: config.accountId !== null,
    maxOpenTrades: config.maxOpenTrades,
    maxDailyLossUsd: config.maxDailyLossUsd,
    requiresSecret: config.apiSecret !== null,
    openPaperTrades: trades.filter(
      (trade) => trade.account_mode === "paper" && trade.status === "open",
    ).length,
    configurationIssues,
    learning: {
      closedPaperTrades: policyModel.closedTradeCount,
      managementExperiences: policyModel.experienceCount,
      learnedContexts: Object.keys(policyModel.buckets).length,
      readyForPolicyPrior: policyModel.experienceCount >= 3,
    },
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

      if (!dryRun) {
        await updateJournalTradeSignalSnapshot(
          trade.id,
          buildUpdatedSignalSnapshot(trade, {
            activeStopUnderlying: nextStopUnderlying,
            activeTargetUnderlying: nextTargetUnderlying,
            managementStyle: "ai",
            lastManagementAction: aiDecision.action,
            lastManagementConfidence: aiDecision.confidence,
            lastManagementNote: aiDecision.note,
            lastManagementThesis: aiDecision.thesis,
            lastManagementAt: nowIso,
            managementHistory: appendManagementHistory(managementHistory, historyEntry),
          }),
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

    const exitOrder: TradeStationOrderRequest = {
      accountId: automation.accountId,
      symbol: automation.optionSymbol,
      quantity: automation.quantity,
      orderType: "Market",
      tradeAction: "SELLTOCLOSE",
      duration: "DAY",
    };
    const orderResult = await client.placeOrder(exitOrder);
    if (isRejectedOrderResult(orderResult)) {
      exitsTriggered.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: decision.reason,
        action: "skipped",
        orderId: orderResult.orderId,
        optionExitPrice: null,
        note: `${decision.note} ${formatRejectedOrderReason(orderResult)}`,
      });
      continue;
    }

    let optionExitPrice = orderResult.averageFillPrice;
    if (optionExitPrice === null && orderResult.orderId) {
      optionExitPrice = await getAverageFillPriceIfAvailable({
        getExecutions: client.getExecutions,
        accountId: automation.accountId,
        orderId: orderResult.orderId,
      });
    }
    if (optionExitPrice === null) {
      optionExitPrice =
        optionQuote.mid
        ?? optionQuote.bid
        ?? readNumber(trade.option_entry_price);
    }
    if (optionExitPrice === null || optionExitPrice <= 0) {
      exitsTriggered.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: decision.reason,
        action: "skipped",
        orderId: orderResult.orderId,
        optionExitPrice: null,
        note: `${decision.note} Exit order was sent, but no usable fill price was available for journaling.`,
      });
      continue;
    }

    await closeJournalTrade(trade.id, {
      option_exit_price: optionExitPrice,
      exit_reason: decision.reason,
      exit_timestamp: nowIso,
      quantity_closed: automation.quantity,
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
      orderId: orderResult.orderId,
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
  openPaperTrades: JournalTradeDetail[];
  todayRealizedPlUsd: number;
  prompt: string;
}): Promise<PaperTraderRunResult["entry"]> {
  const {
    config,
    dryRun,
    openPaperTrades,
    todayRealizedPlUsd,
    prompt,
  } = params;

  if (openPaperTrades.length >= config.maxOpenTrades) {
    return {
      attempted: false,
      outcome: "skipped_after_guard",
      symbol: null,
      reason: `Max open paper trades reached (${openPaperTrades.length}/${config.maxOpenTrades}).`,
    };
  }

  if (todayRealizedPlUsd <= -config.maxDailyLossUsd) {
    return {
      attempted: false,
      outcome: "skipped_after_guard",
      symbol: null,
      reason: `Daily realized paper loss guard hit (${todayRealizedPlUsd.toFixed(2)} <= -${config.maxDailyLossUsd.toFixed(2)}).`,
    };
  }

  const scanRunId = buildScanRunId();
  const scan = await runScan({
    prompt,
    excludedTickers: openPaperTrades.map((trade) => trade.symbol),
    tradestationBaseUrlOverride: config.automationBaseUrl,
  });

  if (
    scan.conclusion !== "confirmed"
    || !scan.ticker
    || !scan.direction
    || !scan.confidence
  ) {
    return {
      attempted: true,
      outcome: "no_trade_today",
      symbol: scan.ticker,
      reason: scan.reason,
      reasoning: buildEntryReasoning(scan, null),
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

    const automation = tradeCard.automationMetadata;
    if (automation.contracts < 1) {
      return {
        attempted: true,
        outcome: "zero_contract_trade",
        symbol: scan.ticker,
        reason: `Trade card sized ${automation.contracts} contracts, so the paper trader skipped the entry.`,
        tradeCard,
        reasoning: buildEntryReasoning(scan, tradeCard),
      };
    }

    const client = await createAutomationTradeStationClient(config.automationBaseUrl);
    const entryLimitPrice = normalizeTradeStationOrderPrice({
      symbol: automation.optionSymbol,
      price: automation.optionLimitPrice,
      tradeAction: automation.entryTradeAction,
    });
    const entryOrder: TradeStationOrderRequest = {
      accountId: config.accountId as string,
      symbol: automation.optionSymbol,
      quantity: automation.contracts,
      orderType: automation.entryOrderType,
      tradeAction: automation.entryTradeAction,
      limitPrice: entryLimitPrice,
      duration: "DAY",
    };
    const confirmation = await client.confirmOrder(entryOrder);
    if (isRejectedOrderResult(confirmation)) {
      return {
        attempted: true,
        outcome: "trade_card_blocked",
        symbol: scan.ticker,
        reason: formatRejectedOrderReason(confirmation),
        tradeCard,
        reasoning: buildEntryReasoning(scan, tradeCard),
      };
    }

    if (dryRun) {
      return {
        attempted: true,
        outcome: "preview_only",
        symbol: scan.ticker,
        reason: `Previewed ${automation.contracts}x ${automation.optionSymbol} at ${entryLimitPrice.toFixed(2)} without sending the order.`,
        tradeCard,
        reasoning: buildEntryReasoning(scan, tradeCard),
      };
    }

    const orderResult = await client.placeOrder(entryOrder);
    if (isRejectedOrderResult(orderResult)) {
      return {
        attempted: true,
        outcome: "trade_card_blocked",
        symbol: scan.ticker,
        reason: formatRejectedOrderReason(orderResult),
        tradeCard,
        reasoning: buildEntryReasoning(scan, tradeCard),
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

    const createdTrade = await createJournalTrade({
      account_mode: "paper",
      entry_date: chicagoNow.date,
      entry_time: chicagoNow.time,
      contracts: automation.contracts,
      option_entry_price: optionEntryPrice,
      entry_notes: "Entered automatically by paper trader module.",
      planned_trade: {
        ...tradeCard.plannedJournalFields,
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
            quantity: automation.contracts,
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
            confirmationStatus: confirmation.status,
            orderStatus: orderResult.status,
          },
        },
      },
      status: "open",
    });

    return {
      attempted: true,
      outcome: "entered_paper_trade",
      symbol: scan.ticker,
      reason: `Entered ${automation.contracts}x ${automation.optionSymbol} in the paper account.`,
      orderId: orderResult.orderId,
      journalTradeId: createdTrade.id,
      tradeCard,
      reasoning: buildEntryReasoning(scan, tradeCard),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trade construction failed.";
    return {
      attempted: true,
      outcome: "trade_card_blocked",
      symbol: scan.ticker,
      reason: message,
      reasoning: buildEntryReasoning(scan, null),
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
  let allTrades = await listJournalTradeDetails(200);
  const shouldReconcileOrders = options.reconcileOrders === true || !dryRun;
  const reconciliation = await reconcileOpenPaperOrders(
    config,
    allTrades,
    shouldReconcileOrders,
  );
  if (reconciliation.updated > 0) {
    allTrades = await listJournalTradeDetails(200);
  }

  const openPaperTrades = allTrades.filter(
    (trade) => trade.account_mode === "paper" && trade.status === "open",
  );
  const chicagoNow = formatChicagoParts(new Date());
  const todayChicago = chicagoNow.date;
  const todayRealizedPlUsd = computeTodayRealizedPlUsd(allTrades, todayChicago);

  if (options.reconcileOnly) {
    return {
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
    };
  }

  if (!dryRun && !isRegularUsEquitySession(new Date())) {
    return {
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
      },
      guards: {
        openPaperTrades: openPaperTrades.length,
        todayRealizedPlUsd,
        newEntriesAllowed:
          openPaperTrades.length < config.maxOpenTrades
          && todayRealizedPlUsd > -config.maxDailyLossUsd,
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
    };
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
        openPaperTrades: remainingOpenPaperTrades,
        todayRealizedPlUsd,
        prompt: options.prompt ?? config.scanPrompt,
      });

  return {
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
    },
    guards: {
      openPaperTrades: remainingOpenPaperTrades.length,
      todayRealizedPlUsd,
      newEntriesAllowed:
      remainingOpenPaperTrades.length < config.maxOpenTrades
      && todayRealizedPlUsd > -config.maxDailyLossUsd,
    },
    reconciliation,
    management,
    entry,
  };
}
