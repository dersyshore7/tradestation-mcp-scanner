import { buildJournalInsights } from "./insights.js";
import {
  supabaseDelete,
  supabaseInsertAndSelectOne,
  supabaseSelect,
  supabaseUpdateAndSelectOne,
  supabaseUpsertAndSelectOne,
} from "../supabase/serverClient.js";
import type {
  AccountMode,
  JournalInsights,
  JournalTradeRecord,
  JournalTradeCloseInput,
  JournalTradeCreateInput,
  JournalTradeDetail,
  JournalTradeExitRecord,
  JournalTradeListItem,
  JournalTradePartialExitInput,
  JournalTradeReviewRecord,
  JournalTradeUpdateInput,
  TradeStatus,
} from "./types.js";

const JOURNAL_TRADE_RECORD_SELECT_WITHOUT_SIGNAL = [
  "id",
  "created_at",
  "updated_at",
  "scan_run_id",
  "account_mode",
  "entry_date",
  "entry_time",
  "symbol",
  "direction",
  "expiration_date",
  "dte_at_entry",
  "contracts",
  "position_cost_usd",
  "underlying_entry_price",
  "option_entry_price",
  "planned_risk_usd",
  "planned_profit_usd",
  "setup_type",
  "setup_subtype",
  "confidence_bucket",
  "intended_stop_underlying",
  "intended_target_underlying",
  "market_regime",
  "entry_notes",
  "status",
].join(",");

type JournalTradeListOptions = {
  includeSignalSnapshot?: boolean;
  accountMode?: AccountMode;
  status?: TradeStatus;
};

type JournalInsightsOptions = {
  includeReasoning?: boolean;
  accountMode?: AccountMode;
};

export type JournalExitBrokerFillUpdateInput = {
  exitId: string;
  optionExitPrice: number;
  quantityClosed?: number | null;
  feesUsd?: number | null;
  slippageUsd?: number | null;
  appendExitNote?: string | null;
};

function buildEntryWeek(entryDate: string): string {
  const date = new Date(`${entryDate}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function buildEntryDay(entryDate: string): string {
  return new Date(`${entryDate}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

function toNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoneyString(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

function formatUnderlyingString(value: number | null): string | null {
  return value === null ? null : value.toFixed(4);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildInFilter(field: string, ids: string[]): string {
  return `${field}=in.(${ids.join(",")})`;
}

function buildSoldForUsd(latestExit: JournalTradeExitRecord | null): string | null {
  if (!latestExit) {
    return null;
  }

  const optionExitPrice = toNumber(latestExit.option_exit_price);
  if (optionExitPrice === null) {
    return null;
  }

  return formatMoneyString(optionExitPrice * latestExit.quantity_closed * 100);
}

function appendJournalNote(existing: string | null, note: string | null | undefined): string | null {
  const normalizedNote = note?.trim();
  if (!normalizedNote) {
    return existing;
  }

  const normalizedExisting = existing?.trim() ?? "";
  if (!normalizedExisting) {
    return normalizedNote;
  }
  if (normalizedExisting.includes(normalizedNote)) {
    return normalizedExisting;
  }
  return `${normalizedExisting} ${normalizedNote}`;
}

function readActiveManagementLevels(trade: JournalTradeRecord): {
  active_stop_underlying: string | null;
  active_target_underlying: string | null;
} {
  const snapshot = asRecord(trade.signal_snapshot_json);
  const automation = asRecord(snapshot?.automation);
  const paperTrader = asRecord(automation?.paperTrader);
  const activeStop = readNumber(paperTrader?.activeStopUnderlying)
    ?? readNumber(paperTrader?.intendedStopUnderlying)
    ?? toNumber(trade.intended_stop_underlying);
  const activeTarget = readNumber(paperTrader?.activeTargetUnderlying)
    ?? readNumber(paperTrader?.intendedTargetUnderlying)
    ?? toNumber(trade.intended_target_underlying);

  return {
    active_stop_underlying: formatUnderlyingString(activeStop),
    active_target_underlying: formatUnderlyingString(activeTarget),
  };
}

function buildTradeDetail(
  trade: JournalTradeRecord,
  exitsByTradeId: Map<string, JournalTradeExitRecord[]>,
  reviewByTradeId: Map<string, JournalTradeReviewRecord>,
): JournalTradeDetail {
  const exits = exitsByTradeId.get(trade.id) ?? [];
  const latestExit = exits[0] ?? null;
  const review = reviewByTradeId.get(trade.id) ?? null;

  return {
    ...trade,
    entry_day: buildEntryDay(trade.entry_date),
    entry_week: buildEntryWeek(trade.entry_date),
    exits,
    latest_exit: latestExit,
    review,
    sold_for_usd: buildSoldForUsd(latestExit),
  };
}

async function fetchTradeExits(tradeIds: string[]): Promise<JournalTradeExitRecord[]> {
  if (tradeIds.length === 0) {
    return [];
  }

  return await supabaseSelect<JournalTradeExitRecord>({
    table: "journal_exits",
    select: "*",
    filters: [buildInFilter("trade_id", tradeIds)],
    order: ["exit_time.desc"],
  });
}

async function fetchTradeReviews(tradeIds: string[]): Promise<JournalTradeReviewRecord[]> {
  if (tradeIds.length === 0) {
    return [];
  }

  return await supabaseSelect<JournalTradeReviewRecord>({
    table: "journal_reviews",
    select: "*",
    filters: [buildInFilter("trade_id", tradeIds)],
  });
}

async function hydrateJournalTrades(trades: JournalTradeRecord[]): Promise<JournalTradeDetail[]> {
  if (trades.length === 0) {
    return [];
  }

  const tradeIds = trades.map((trade) => trade.id);
  const [exits, reviews] = await Promise.all([
    fetchTradeExits(tradeIds),
    fetchTradeReviews(tradeIds),
  ]);

  const exitsByTradeId = exits.reduce((map, exit) => {
    const existing = map.get(exit.trade_id) ?? [];
    existing.push(exit);
    map.set(exit.trade_id, existing);
    return map;
  }, new Map<string, JournalTradeExitRecord[]>());
  const reviewByTradeId = reviews.reduce((map, review) => {
    map.set(review.trade_id, review);
    return map;
  }, new Map<string, JournalTradeReviewRecord>());

  return trades.map((trade) => buildTradeDetail(trade, exitsByTradeId, reviewByTradeId));
}

function toListItem(detail: JournalTradeDetail): JournalTradeListItem {
  const activeLevels = readActiveManagementLevels(detail);

  return {
    id: detail.id,
    created_at: detail.created_at,
    entry_date: detail.entry_date,
    symbol: detail.symbol,
    direction: detail.direction,
    expiration_date: detail.expiration_date,
    setup_type: detail.setup_type,
    status: detail.status,
    account_mode: detail.account_mode,
    position_cost_usd: detail.position_cost_usd,
    underlying_entry_price: detail.underlying_entry_price,
    option_entry_price: detail.option_entry_price,
    contracts: detail.contracts,
    intended_stop_underlying: detail.intended_stop_underlying,
    intended_target_underlying: detail.intended_target_underlying,
    entry_day: detail.entry_day,
    entry_week: detail.entry_week,
    active_stop_underlying: activeLevels.active_stop_underlying,
    active_target_underlying: activeLevels.active_target_underlying,
    exit_option_price: detail.latest_exit?.option_exit_price ?? null,
    sold_for_usd: detail.sold_for_usd,
    realized_pl_usd: detail.review?.realized_pl_usd ?? null,
    realized_r_multiple: detail.review?.realized_r_multiple ?? null,
    realized_return_pct: detail.review?.realized_return_pct ?? null,
    winner: detail.review?.winner ?? null,
    latest_exit_reason: detail.latest_exit?.exit_reason ?? null,
  };
}

function normalizeJournalTradeRecord(record: JournalTradeRecord): JournalTradeRecord {
  return {
    ...record,
    signal_snapshot_json: record.signal_snapshot_json ?? null,
  };
}

async function listJournalTradeRecords(
  limit = 50,
  options: JournalTradeListOptions = {},
): Promise<JournalTradeRecord[]> {
  const includeSignalSnapshot = options.includeSignalSnapshot !== false;
  const records = await supabaseSelect<JournalTradeRecord>({
    table: "journal_trades",
    select: includeSignalSnapshot ? "*" : JOURNAL_TRADE_RECORD_SELECT_WITHOUT_SIGNAL,
    filters: [
      ...(options.accountMode ? [`account_mode=eq.${options.accountMode}`] : []),
      ...(options.status ? [`status=eq.${options.status}`] : []),
    ],
    order: ["entry_date.desc", "created_at.desc"],
    limit,
  });
  return records.map(normalizeJournalTradeRecord);
}

function inferQuantityClosed(trade: JournalTradeRecord, requestedQuantity: number | null | undefined): number {
  if (typeof requestedQuantity === "number" && requestedQuantity > 0) {
    return requestedQuantity;
  }

  if (typeof trade.contracts === "number" && trade.contracts > 0) {
    return trade.contracts;
  }

  const optionEntryPrice = toNumber(trade.option_entry_price);
  const positionCostUsd = toNumber(trade.position_cost_usd);
  if (optionEntryPrice !== null && optionEntryPrice > 0 && positionCostUsd !== null && positionCostUsd > 0) {
    const derivedContracts = Math.round(positionCostUsd / (optionEntryPrice * 100));
    if (derivedContracts > 0) {
      return derivedContracts;
    }
  }

  throw new Error("Could not infer quantity_closed for this trade. Please provide it explicitly.");
}

function resolvePositionCostUsd(
  contracts: number | null | undefined,
  optionEntryPrice: number | null | undefined,
  plannedPositionCostUsd: number,
): number {
  if (
    typeof contracts === "number"
    && contracts > 0
    && typeof optionEntryPrice === "number"
    && optionEntryPrice > 0
  ) {
    return contracts * optionEntryPrice * 100;
  }

  return plannedPositionCostUsd;
}

function inferEntryQuantityForReview(
  trade: Pick<JournalTradeRecord, "contracts" | "position_cost_usd" | "option_entry_price">,
  quantityClosed: number,
): number {
  if (typeof trade.contracts === "number" && trade.contracts > 0) {
    return trade.contracts;
  }

  const optionEntryPrice = toNumber(trade.option_entry_price);
  const positionCostUsd = toNumber(trade.position_cost_usd);
  if (optionEntryPrice !== null && optionEntryPrice > 0 && positionCostUsd !== null && positionCostUsd > 0) {
    const derivedContracts = Math.round(positionCostUsd / (optionEntryPrice * 100));
    if (derivedContracts > 0) {
      return derivedContracts;
    }
  }

  return quantityClosed;
}

export function calculateCloseReviewValues(
  trade: Pick<JournalTradeRecord, "contracts" | "position_cost_usd" | "option_entry_price" | "planned_risk_usd">,
  latestExit: Pick<JournalTradeExitRecord, "option_exit_price" | "quantity_closed" | "fees_usd" | "slippage_usd">,
): {
  soldForUsd: number;
  realizedPlUsd: number;
  realizedRMultiple: number | null;
  realizedReturnPct: number | null;
} {
  const optionExitPrice = toNumber(latestExit.option_exit_price) ?? 0;
  const positionCostUsd = toNumber(trade.position_cost_usd) ?? 0;
  const plannedRiskUsd = toNumber(trade.planned_risk_usd);
  const feesUsd = toNumber(latestExit.fees_usd) ?? 0;
  const slippageUsd = toNumber(latestExit.slippage_usd) ?? 0;
  const entryQuantity = inferEntryQuantityForReview(trade, latestExit.quantity_closed);
  const closedQuantityRatio = entryQuantity > 0
    ? latestExit.quantity_closed / entryQuantity
    : 1;
  const closedPositionCostUsd = positionCostUsd * closedQuantityRatio;
  const closedPlannedRiskUsd = plannedRiskUsd !== null
    ? plannedRiskUsd * closedQuantityRatio
    : null;
  const soldForUsd = optionExitPrice * latestExit.quantity_closed * 100;
  const realizedPlUsd = soldForUsd - closedPositionCostUsd - feesUsd - slippageUsd;
  const realizedRMultiple = closedPlannedRiskUsd !== null && closedPlannedRiskUsd > 0
    ? realizedPlUsd / closedPlannedRiskUsd
    : null;
  const realizedReturnPct = closedPositionCostUsd > 0 ? (realizedPlUsd / closedPositionCostUsd) * 100 : null;

  return {
    soldForUsd,
    realizedPlUsd,
    realizedRMultiple,
    realizedReturnPct,
  };
}

function inferEntryCostPerContract(
  trade: Pick<JournalTradeRecord, "contracts" | "position_cost_usd" | "option_entry_price">,
): number {
  const optionEntryPrice = toNumber(trade.option_entry_price);
  if (optionEntryPrice !== null && optionEntryPrice > 0) {
    return optionEntryPrice * 100;
  }

  const positionCostUsd = toNumber(trade.position_cost_usd) ?? 0;
  if (typeof trade.contracts === "number" && trade.contracts > 0 && positionCostUsd > 0) {
    return positionCostUsd / trade.contracts;
  }

  return 0;
}

export function calculateAggregateCloseReviewValues(
  trade: Pick<JournalTradeRecord, "contracts" | "position_cost_usd" | "option_entry_price" | "planned_risk_usd">,
  exits: Pick<JournalTradeExitRecord, "option_exit_price" | "quantity_closed" | "fees_usd" | "slippage_usd">[],
): {
  soldForUsd: number;
  realizedPlUsd: number;
  realizedRMultiple: number | null;
  realizedReturnPct: number | null;
} {
  const entryCostPerContract = inferEntryCostPerContract(trade);
  const plannedRiskUsd = toNumber(trade.planned_risk_usd);
  const totalClosedQuantity = exits.reduce((sum, exit) => sum + exit.quantity_closed, 0);
  const soldForUsd = exits.reduce(
    (sum, exit) => sum + ((toNumber(exit.option_exit_price) ?? 0) * exit.quantity_closed * 100),
    0,
  );
  const totalFeesUsd = exits.reduce(
    (sum, exit) => sum + (toNumber(exit.fees_usd) ?? 0) + (toNumber(exit.slippage_usd) ?? 0),
    0,
  );
  const closedPositionCostUsd = entryCostPerContract * totalClosedQuantity;
  const originalQuantity = totalClosedQuantity;
  const closedRiskUsd =
    plannedRiskUsd !== null && plannedRiskUsd > 0 && originalQuantity > 0
      ? plannedRiskUsd * (totalClosedQuantity / originalQuantity)
      : null;
  const realizedPlUsd = soldForUsd - closedPositionCostUsd - totalFeesUsd;
  const realizedRMultiple = closedRiskUsd !== null && closedRiskUsd > 0
    ? realizedPlUsd / closedRiskUsd
    : null;
  const realizedReturnPct = closedPositionCostUsd > 0
    ? (realizedPlUsd / closedPositionCostUsd) * 100
    : null;

  return {
    soldForUsd,
    realizedPlUsd,
    realizedRMultiple,
    realizedReturnPct,
  };
}

export function calculateRemainingPositionAfterPartialExit(
  trade: Pick<JournalTradeRecord, "contracts" | "position_cost_usd" | "option_entry_price">,
  quantityClosed: number,
): {
  remainingContracts: number;
  remainingPositionCostUsd: number;
} {
  const currentContracts = trade.contracts ?? 0;
  if (quantityClosed <= 0 || currentContracts <= 0 || quantityClosed >= currentContracts) {
    throw new Error("Partial exit quantity must leave at least one open contract.");
  }

  const remainingContracts = currentContracts - quantityClosed;
  const optionEntryPrice = toNumber(trade.option_entry_price);
  const currentPositionCostUsd = toNumber(trade.position_cost_usd) ?? 0;
  const remainingPositionCostUsd = optionEntryPrice !== null && optionEntryPrice > 0
    ? remainingContracts * optionEntryPrice * 100
    : currentPositionCostUsd * (remainingContracts / currentContracts);

  return {
    remainingContracts,
    remainingPositionCostUsd: Number(remainingPositionCostUsd.toFixed(2)),
  };
}

function hasExitFieldUpdates(input: JournalTradeUpdateInput): boolean {
  return input.option_exit_price !== undefined
    || input.quantity_closed !== undefined
    || input.exit_reason !== undefined
    || input.exit_timestamp !== undefined
    || input.lessons_learned !== undefined
    || input.review_notes !== undefined;
}

export async function createJournalTrade(input: JournalTradeCreateInput): Promise<JournalTradeRecord> {
  const { planned_trade: planned, signal_snapshot_json, ...entry } = input;
  const positionCostUsd = resolvePositionCostUsd(entry.contracts, entry.option_entry_price, planned.position_cost_usd);

  const insertPayload = {
    scan_run_id: planned.scan_run_id ?? null,
    account_mode: entry.account_mode,
    entry_date: entry.entry_date,
    entry_time: entry.entry_time ?? null,
    symbol: planned.symbol,
    direction: planned.direction,
    expiration_date: planned.expiration_date ?? null,
    dte_at_entry: planned.dte_at_entry ?? null,
    contracts: entry.contracts ?? null,
    position_cost_usd: positionCostUsd,
    underlying_entry_price: planned.underlying_entry_price ?? null,
    option_entry_price: entry.option_entry_price ?? null,
    planned_risk_usd: planned.planned_risk_usd ?? null,
    planned_profit_usd: planned.planned_profit_usd ?? null,
    setup_type: planned.setup_type,
    setup_subtype: planned.setup_subtype ?? null,
    confidence_bucket: planned.confidence_bucket ?? null,
    intended_stop_underlying: planned.intended_stop_underlying ?? null,
    intended_target_underlying: planned.intended_target_underlying ?? null,
    market_regime: planned.market_regime ?? null,
    signal_snapshot_json: signal_snapshot_json ?? null,
    entry_notes: entry.entry_notes ?? null,
    status: entry.status ?? "open",
  };

  return await supabaseInsertAndSelectOne<JournalTradeRecord>({
    table: "journal_trades",
    values: insertPayload,
  });
}

export async function listRecentJournalTrades(limit = 50): Promise<JournalTradeListItem[]> {
  const trades = await listJournalTradeRecords(limit, { includeSignalSnapshot: false });
  const details = await hydrateJournalTrades(trades);
  return details.map(toListItem);
}

export async function listJournalTradeDetails(
  limit = 200,
  options: JournalTradeListOptions = {},
): Promise<JournalTradeDetail[]> {
  const trades = await listJournalTradeRecords(limit, options);
  return await hydrateJournalTrades(trades);
}

export async function getJournalTradeById(id: string): Promise<JournalTradeDetail | null> {
  const data = await supabaseSelect<JournalTradeRecord>({
    table: "journal_trades",
    select: "*",
    filters: [`id=eq.${id}`],
    single: "maybeSingle",
  });
  const trade = data[0] ?? null;
  if (!trade) {
    return null;
  }

  const hydrated = await hydrateJournalTrades([trade]);
  return hydrated[0] ?? null;
}

export async function updateJournalTradeSignalSnapshot(
  id: string,
  signalSnapshotJson: Record<string, unknown> | null,
): Promise<JournalTradeDetail> {
  await supabaseUpdateAndSelectOne<JournalTradeRecord>({
    table: "journal_trades",
    filters: [`id=eq.${id}`],
    values: {
      signal_snapshot_json: signalSnapshotJson,
    },
  });

  const refreshedTrade = await getJournalTradeById(id);
  if (!refreshedTrade) {
    throw new Error("Updated trade could not be reloaded.");
  }

  return refreshedTrade;
}

export async function archiveJournalTradeWithoutReview(
  id: string,
  input: { entry_notes?: string | null } = {},
): Promise<JournalTradeDetail> {
  await supabaseUpdateAndSelectOne<JournalTradeRecord>({
    table: "journal_trades",
    filters: [`id=eq.${id}`],
    values: {
      status: "closed",
      ...(input.entry_notes !== undefined ? { entry_notes: input.entry_notes } : {}),
    },
  });

  const refreshedTrade = await getJournalTradeById(id);
  if (!refreshedTrade) {
    throw new Error("Archived trade could not be reloaded.");
  }

  return refreshedTrade;
}

export async function updateJournalTrade(id: string, input: JournalTradeUpdateInput): Promise<JournalTradeDetail> {
  const trade = await getJournalTradeById(id);
  if (!trade) {
    throw new Error("Journal trade not found.");
  }

  const entryDate = input.entry_date ?? trade.entry_date;
  if (trade.expiration_date && trade.expiration_date < entryDate) {
    throw new Error("entry_date must be on/before expiration_date.");
  }

  if (trade.status !== "closed" && hasExitFieldUpdates(input)) {
    throw new Error("Only closed trades can update exit details.");
  }

  const contracts = input.contracts ?? trade.contracts;
  const optionEntryPrice = input.option_entry_price ?? toNumber(trade.option_entry_price);
  const positionCostUsd = resolvePositionCostUsd(
    contracts,
    optionEntryPrice,
    toNumber(trade.position_cost_usd) ?? 0,
  );

  const updatedTrade = await supabaseUpdateAndSelectOne<JournalTradeRecord>({
    table: "journal_trades",
    filters: [`id=eq.${id}`],
    values: {
      account_mode: input.account_mode ?? trade.account_mode,
      entry_date: entryDate,
      entry_time: input.entry_time !== undefined ? input.entry_time : trade.entry_time,
      contracts,
      option_entry_price: optionEntryPrice,
      position_cost_usd: positionCostUsd,
      entry_notes: input.entry_notes !== undefined ? input.entry_notes : trade.entry_notes,
    },
  });

  if (trade.status === "closed" && trade.latest_exit) {
    const updatedExit = await supabaseUpdateAndSelectOne<JournalTradeExitRecord>({
      table: "journal_exits",
      filters: [`id=eq.${trade.latest_exit.id}`],
      values: {
        exit_time: input.exit_timestamp ?? trade.latest_exit.exit_time,
        option_exit_price: input.option_exit_price ?? toNumber(trade.latest_exit.option_exit_price),
        quantity_closed: input.quantity_closed ?? trade.latest_exit.quantity_closed,
        exit_reason: input.exit_reason ?? trade.latest_exit.exit_reason,
      },
    });

    const exitsForReview = trade.exits.map((exit) =>
      exit.id === updatedExit.id ? updatedExit : exit
    );
    const reviewValues = calculateAggregateCloseReviewValues(updatedTrade, exitsForReview);
    await supabaseUpsertAndSelectOne<JournalTradeReviewRecord>({
      table: "journal_reviews",
      onConflict: "trade_id",
      values: {
        trade_id: id,
        followed_plan: trade.review?.followed_plan ?? null,
        winner: reviewValues.realizedPlUsd > 0,
        realized_pl_usd: reviewValues.realizedPlUsd,
        realized_r_multiple: reviewValues.realizedRMultiple,
        realized_return_pct: reviewValues.realizedReturnPct,
        rule_break_tags: trade.review?.rule_break_tags ?? [],
        review_grade: trade.review?.review_grade ?? null,
        mistake_category: trade.review?.mistake_category ?? null,
        lessons_learned: input.lessons_learned !== undefined ? input.lessons_learned : (trade.review?.lessons_learned ?? null),
        review_notes: input.review_notes !== undefined ? input.review_notes : (trade.review?.review_notes ?? null),
      },
    });
  }

  const refreshedTrade = await getJournalTradeById(id);
  if (!refreshedTrade) {
    throw new Error("Updated trade could not be reloaded.");
  }

  return refreshedTrade;
}

export async function recomputeJournalTradeReviewFromExits(id: string): Promise<JournalTradeDetail> {
  const trade = await getJournalTradeById(id);
  if (!trade) {
    throw new Error("Journal trade not found.");
  }
  if (trade.status !== "closed") {
    throw new Error("Only closed trades can recompute review values.");
  }
  if (trade.exits.length === 0) {
    throw new Error("Closed trade has no exits to recompute from.");
  }

  const reviewValues = calculateAggregateCloseReviewValues(trade, trade.exits);
  await supabaseUpsertAndSelectOne<JournalTradeReviewRecord>({
    table: "journal_reviews",
    onConflict: "trade_id",
    values: {
      trade_id: id,
      followed_plan: trade.review?.followed_plan ?? null,
      winner: reviewValues.realizedPlUsd > 0,
      realized_pl_usd: reviewValues.realizedPlUsd,
      realized_r_multiple: reviewValues.realizedRMultiple,
      realized_return_pct: reviewValues.realizedReturnPct,
      rule_break_tags: trade.review?.rule_break_tags ?? [],
      review_grade: trade.review?.review_grade ?? null,
      mistake_category: trade.review?.mistake_category ?? null,
      lessons_learned: trade.review?.lessons_learned ?? null,
      review_notes: trade.review?.review_notes ?? null,
    },
  });

  const refreshedTrade = await getJournalTradeById(id);
  if (!refreshedTrade) {
    throw new Error("Recomputed trade could not be reloaded.");
  }

  return refreshedTrade;
}

export async function updateJournalExitWithBrokerFill(
  input: JournalExitBrokerFillUpdateInput,
): Promise<JournalTradeDetail> {
  const existingExitRows = await supabaseSelect<JournalTradeExitRecord>({
    table: "journal_exits",
    select: "*",
    filters: [`id=eq.${input.exitId}`],
    single: "maybeSingle",
  });
  const existingExit = existingExitRows[0] ?? null;
  if (!existingExit) {
    throw new Error("Journal exit not found.");
  }

  const trade = await getJournalTradeById(existingExit.trade_id);
  if (!trade) {
    throw new Error("Journal trade not found for exit update.");
  }

  const updatedExit = await supabaseUpdateAndSelectOne<JournalTradeExitRecord>({
    table: "journal_exits",
    filters: [`id=eq.${existingExit.id}`],
    values: {
      option_exit_price: input.optionExitPrice,
      quantity_closed: input.quantityClosed ?? existingExit.quantity_closed,
      fees_usd: input.feesUsd ?? toNumber(existingExit.fees_usd) ?? 0,
      slippage_usd: input.slippageUsd ?? toNumber(existingExit.slippage_usd) ?? 0,
      exit_notes: appendJournalNote(existingExit.exit_notes, input.appendExitNote),
    },
  });

  const exitsForReview = trade.exits.map((exit) =>
    exit.id === updatedExit.id ? updatedExit : exit
  );
  const reviewValues = calculateAggregateCloseReviewValues(trade, exitsForReview);
  await supabaseUpsertAndSelectOne<JournalTradeReviewRecord>({
    table: "journal_reviews",
    onConflict: "trade_id",
    values: {
      trade_id: trade.id,
      followed_plan: trade.review?.followed_plan ?? null,
      winner: reviewValues.realizedPlUsd > 0,
      realized_pl_usd: reviewValues.realizedPlUsd,
      realized_r_multiple: reviewValues.realizedRMultiple,
      realized_return_pct: reviewValues.realizedReturnPct,
      rule_break_tags: trade.review?.rule_break_tags ?? [],
      review_grade: trade.review?.review_grade ?? null,
      mistake_category: trade.review?.mistake_category ?? null,
      lessons_learned: trade.review?.lessons_learned ?? null,
      review_notes: trade.review?.review_notes ?? null,
    },
  });

  const refreshedTrade = await getJournalTradeById(trade.id);
  if (!refreshedTrade) {
    throw new Error("Broker-fill exit update could not be reloaded.");
  }
  return refreshedTrade;
}

export async function closeJournalTrade(id: string, input: JournalTradeCloseInput): Promise<JournalTradeDetail> {
  const trade = await getJournalTradeById(id);
  if (!trade) {
    throw new Error("Journal trade not found.");
  }

  const quantityClosed = inferQuantityClosed(trade, input.quantity_closed);
  const optionExitPrice = input.option_exit_price ?? (
    input.sold_for_usd !== null && input.sold_for_usd !== undefined
      ? input.sold_for_usd / (quantityClosed * 100)
      : null
  );
  if (optionExitPrice === null || optionExitPrice <= 0) {
    throw new Error("option_exit_price is required to close a trade.");
  }

  const feesUsd = input.fees_usd ?? 0;
  const slippageUsd = input.slippage_usd ?? 0;
  const finalExit = await supabaseInsertAndSelectOne<JournalTradeExitRecord>({
    table: "journal_exits",
    values: {
      trade_id: id,
      exit_time: input.exit_timestamp,
      option_exit_price: optionExitPrice,
      quantity_closed: quantityClosed,
      exit_reason: input.exit_reason,
      fees_usd: feesUsd,
      slippage_usd: slippageUsd,
      exit_notes: input.exit_notes ?? null,
    },
  });
  const reviewValues = calculateAggregateCloseReviewValues(trade, [
    ...trade.exits,
    finalExit,
  ]);

  await supabaseUpsertAndSelectOne<JournalTradeReviewRecord>({
    table: "journal_reviews",
    onConflict: "trade_id",
    values: {
      trade_id: id,
      winner: reviewValues.realizedPlUsd > 0,
      realized_pl_usd: reviewValues.realizedPlUsd,
      realized_r_multiple: reviewValues.realizedRMultiple,
      realized_return_pct: reviewValues.realizedReturnPct,
      rule_break_tags: [],
      lessons_learned: input.lessons_learned ?? null,
      review_notes: input.review_notes ?? null,
    },
  });

  await supabaseUpdateAndSelectOne<JournalTradeRecord>({
    table: "journal_trades",
    filters: [`id=eq.${id}`],
    values: {
      status: "closed",
    },
  });

  const refreshedTrade = await getJournalTradeById(id);
  if (!refreshedTrade) {
    throw new Error("Closed trade could not be reloaded.");
  }

  return refreshedTrade;
}

export async function recordPartialJournalExit(
  id: string,
  input: JournalTradePartialExitInput,
): Promise<JournalTradeDetail> {
  const trade = await getJournalTradeById(id);
  if (!trade) {
    throw new Error("Journal trade not found.");
  }
  if (trade.status !== "open") {
    throw new Error("Only open trades can record partial exits.");
  }

  const quantityClosed = inferQuantityClosed(trade, input.quantity_closed);
  const remainingPosition = calculateRemainingPositionAfterPartialExit(trade, quantityClosed);
  const optionExitPrice = input.option_exit_price ?? (
    input.sold_for_usd !== null && input.sold_for_usd !== undefined
      ? input.sold_for_usd / (quantityClosed * 100)
      : null
  );
  if (optionExitPrice === null || optionExitPrice <= 0) {
    throw new Error("option_exit_price is required to record a partial exit.");
  }

  const feesUsd = input.fees_usd ?? 0;
  const slippageUsd = input.slippage_usd ?? 0;
  await supabaseInsertAndSelectOne<JournalTradeExitRecord>({
    table: "journal_exits",
    values: {
      trade_id: id,
      exit_time: input.exit_timestamp,
      option_exit_price: optionExitPrice,
      quantity_closed: quantityClosed,
      exit_reason: "partial_profit",
      fees_usd: feesUsd,
      slippage_usd: slippageUsd,
      exit_notes: input.exit_notes ?? null,
    },
  });

  await supabaseUpdateAndSelectOne<JournalTradeRecord>({
    table: "journal_trades",
    filters: [`id=eq.${id}`],
    values: {
      contracts: remainingPosition.remainingContracts,
      position_cost_usd: remainingPosition.remainingPositionCostUsd,
    },
  });

  const refreshedTrade = await getJournalTradeById(id);
  if (!refreshedTrade) {
    throw new Error("Partially exited trade could not be reloaded.");
  }

  return refreshedTrade;
}

export async function deleteJournalTrade(id: string): Promise<void> {
  const trade = await getJournalTradeById(id);
  if (!trade) {
    throw new Error("Journal trade not found.");
  }

  await supabaseDelete({
    table: "journal_trades",
    filters: [`id=eq.${id}`],
  });
}

export async function getJournalInsights(limit = 500, options: JournalInsightsOptions = {}): Promise<JournalInsights> {
  const includeReasoning = options.includeReasoning === true;
  const details = await listJournalTradeDetails(limit, {
    includeSignalSnapshot: includeReasoning,
    ...(options.accountMode ? { accountMode: options.accountMode } : {}),
  });
  return buildJournalInsights(details, { reasoningIncluded: includeReasoning });
}
