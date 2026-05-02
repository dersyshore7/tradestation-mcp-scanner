import { buildJournalInsights } from "./insights.js";
import {
  supabaseDelete,
  supabaseInsertAndSelectOne,
  supabaseSelect,
  supabaseUpdateAndSelectOne,
  supabaseUpsertAndSelectOne,
} from "../supabase/serverClient.js";
import type {
  JournalInsights,
  JournalTradeRecord,
  JournalTradeCloseInput,
  JournalTradeCreateInput,
  JournalTradeDetail,
  JournalTradeExitRecord,
  JournalTradeListItem,
  JournalTradeReviewRecord,
  JournalTradeUpdateInput,
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
};

type JournalInsightsOptions = {
  includeReasoning?: boolean;
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

function calculateCloseReviewValues(
  trade: Pick<JournalTradeRecord, "position_cost_usd" | "planned_risk_usd">,
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
  const soldForUsd = optionExitPrice * latestExit.quantity_closed * 100;
  const realizedPlUsd = soldForUsd - positionCostUsd - feesUsd - slippageUsd;
  const realizedRMultiple = plannedRiskUsd !== null && plannedRiskUsd > 0
    ? realizedPlUsd / plannedRiskUsd
    : null;
  const realizedReturnPct = positionCostUsd > 0 ? (realizedPlUsd / positionCostUsd) * 100 : null;

  return {
    soldForUsd,
    realizedPlUsd,
    realizedRMultiple,
    realizedReturnPct,
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

    const reviewValues = calculateCloseReviewValues(updatedTrade, updatedExit);
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
  const reviewValues = calculateCloseReviewValues(trade, {
    option_exit_price: String(optionExitPrice),
    quantity_closed: quantityClosed,
    fees_usd: String(feesUsd),
    slippage_usd: String(slippageUsd),
  });

  await supabaseInsertAndSelectOne<JournalTradeExitRecord>({
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
  const details = await listJournalTradeDetails(limit, { includeSignalSnapshot: includeReasoning });
  return buildJournalInsights(details, { reasoningIncluded: includeReasoning });
}
