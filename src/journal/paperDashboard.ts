import { readPaperLearningWindow } from "../automation/paperLearningCutoff.js";
import { buildLearningOutcomeAudit, type LearningOutcomeAudit } from "../automation/learningOutcomeAudit.js";
import { buildReasoningSnapshot } from "./insights.js";
import { buildLossPostMortem, type LossTradePostMortem } from "./lossPostMortem.js";
import { listJournalTradeDetails } from "./repository.js";
import { supabaseCount, supabaseSelect } from "../supabase/serverClient.js";
import type { AccountMode, JournalExitPriceSource, JournalReasoningSnapshot } from "./types.js";

const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CURRENT_EPOCH_SCOPE_LABEL = "Current learning epoch" as const;
const PAPER_DASHBOARD_METRIC_LIMIT = 5000;
const PAPER_DASHBOARD_OUTCOME_DETAIL_LIMIT = 50;
const CHICAGO_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type NumericValue = number | string | null;
export type HoldingPeriodBucket = "open" | "intraday" | "overnight" | "multi_day" | "unknown";

const HOLDING_PERIOD_LABELS: Record<HoldingPeriodBucket, string> = {
  open: "Open",
  intraday: "Intraday",
  overnight: "Overnight",
  multi_day: "Multi-day",
  unknown: "Unknown",
};
const HOLDING_PERIOD_ORDER: HoldingPeriodBucket[] = ["open", "intraday", "overnight", "multi_day", "unknown"];

type PaperDashboardTradeRow = {
  id: string;
  created_at: string;
  account_mode: AccountMode;
  entry_date: string;
  entry_time: string | null;
  symbol: string;
  direction: "CALL" | "PUT";
  setup_type: string;
  status: "open" | "closed";
  contracts: NumericValue;
  position_cost_usd: string | null;
  underlying_entry_price: NumericValue;
  option_entry_price: NumericValue;
  planned_risk_usd: NumericValue;
  intended_stop_underlying: NumericValue;
  intended_target_underlying: NumericValue;
  entry_notes: string | null;
};

type PaperDashboardReviewRow = {
  trade_id: string;
  winner: boolean | null;
  realized_pl_usd: NumericValue;
  realized_r_multiple: NumericValue;
  realized_return_pct: NumericValue;
  review_notes: string | null;
};

type PaperDashboardExitRow = {
  id: string;
  trade_id: string;
  exit_time: string;
  exit_reason: string;
  option_exit_price: NumericValue;
  quantity_closed: number;
  fees_usd: NumericValue;
  slippage_usd: NumericValue;
  exit_notes: string | null;
  exit_price_source: JournalExitPriceSource;
  broker_confirmed: boolean;
  broker_repaired: boolean;
  broker_order_id: string | null;
};

type PaperDashboardLegacyExitRow = Omit<
  PaperDashboardExitRow,
  "exit_price_source" | "broker_confirmed" | "broker_repaired" | "broker_order_id"
>;

type PaperDashboardOutcomeDetailRow = {
  id: string;
  signal_snapshot_json: Record<string, unknown> | null;
};

export type PaperDashboardBrokerAudit = {
  provisional_exit_count: number;
  broker_confirmed_exit_count: number;
  broker_repaired_exit_count: number;
};

export type PaperDashboardBrokerAuditExit = {
  exit_price_source: JournalExitPriceSource | null;
  broker_confirmed: boolean | null;
  broker_repaired: boolean | null;
};

export type PaperDashboardBucket = {
  key: string;
  label: string;
  trade_count: number;
  open_trade_count: number;
  closed_trade_count: number;
  open_position_cost_usd: number;
  winner_count: number;
  loser_count: number;
  win_rate: number | null;
  realized_pl_usd: number;
  average_r_multiple: number | null;
  average_return_pct: number | null;
};

export type PaperDashboardOutcomeTrade = {
  id: string;
  symbol: string;
  direction: "CALL" | "PUT";
  setup_type: string;
  entry_date: string;
  entry_time: string | null;
  entry_day: string;
  holding_period_bucket: HoldingPeriodBucket;
  exit_time: string | null;
  exit_reason: string | null;
  contracts: number | null;
  position_cost_usd: number | null;
  underlying_entry_price: number | null;
  option_entry_price: number | null;
  option_exit_price: number | null;
  quantity_closed: number | null;
  sold_for_usd: number | null;
  intended_stop_underlying: number | null;
  intended_target_underlying: number | null;
  active_stop_underlying: number | null;
  active_target_underlying: number | null;
  realized_pl_usd: number | null;
  realized_r_multiple: number | null;
  realized_return_pct: number | null;
  entry_notes: string | null;
  exit_notes: string | null;
  exit_price_source: JournalExitPriceSource | null;
  broker_order_id: string | null;
  review_notes: string | null;
  provisional_exit: boolean;
  broker_confirmed_exit: boolean;
  broker_repaired_exit: boolean;
  exits: Array<{
    exit_time: string;
    exit_reason: string;
    option_exit_price: number | null;
    quantity_closed: number | null;
    exit_price_source: JournalExitPriceSource | null;
    broker_confirmed: boolean;
    broker_repaired: boolean;
  }>;
  post_mortem: LossTradePostMortem | null;
  reasoning: JournalReasoningSnapshot | null;
};

export type PaperDashboard = {
  dataWarnings: string[];
  accountMode: AccountMode;
  learningStartAt: string;
  includedTradeCount: number;
  excludedTradeCount: number;
  scopeLabel: typeof CURRENT_EPOCH_SCOPE_LABEL;
  totals: {
    total_trades: number;
    open_trades: number;
    closed_trades: number;
    open_position_cost_usd: number;
    winners: number;
    losers: number;
    win_rate: number | null;
    total_realized_pl_usd: number;
    average_r_multiple: number | null;
    average_return_pct: number | null;
    best_day_of_week: string | null;
    best_entry_time: string | null;
    best_setup_type: string | null;
  };
  by_day_of_week: PaperDashboardBucket[];
  by_entry_hour: PaperDashboardBucket[];
  by_direction: PaperDashboardBucket[];
  by_setup_type: PaperDashboardBucket[];
  by_symbol: PaperDashboardBucket[];
  by_exit_reason: PaperDashboardBucket[];
  by_holding_period: PaperDashboardBucket[];
  learning_audit: LearningOutcomeAudit;
  broker_audit: PaperDashboardBrokerAudit;
  outcome_details: {
    winners: PaperDashboardOutcomeTrade[];
    losers: PaperDashboardOutcomeTrade[];
    limit: number;
  };
};

type PaperDashboardTrade = PaperDashboardTradeRow & {
  entry_day: string;
  entry_hour_key: string;
  entry_hour_label: string;
  holding_period_bucket: HoldingPeriodBucket;
  review: PaperDashboardReviewRow | null;
  exits: PaperDashboardExitRow[];
  latest_exit: PaperDashboardExitRow | null;
};

export type PaperDashboardHoldingPeriodBucketInput = {
  status: "open" | "closed";
  holding_period_bucket: HoldingPeriodBucket;
  position_cost_usd?: NumericValue;
  review?: {
    winner?: boolean | null;
    realized_pl_usd?: NumericValue;
    realized_r_multiple?: NumericValue;
    realized_return_pct?: NumericValue;
  } | null;
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function average(values: number[]): number | null {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function buildInFilter(field: string, ids: string[]): string {
  return `${field}=in.(${ids.join(",")})`;
}

function buildEntryDay(entryDate: string): string {
  return new Date(`${entryDate}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
}

function buildEntryHourKey(entryTime: string | null): string {
  const hour = typeof entryTime === "string" ? entryTime.match(/^(\d{2})/)?.[1] : null;
  return hour ? `${hour}:00` : "unknown";
}

function buildEntryHourLabel(key: string): string {
  if (key === "unknown") {
    return "Unknown";
  }
  const hour = Number(key.slice(0, 2));
  if (!Number.isFinite(hour)) {
    return key;
  }
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12} ${suffix}`;
}

function parseDateKey(value: string | null): { key: string; dayIndex: number } | null {
  const match = typeof value === "string" ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!match) {
    return null;
  }

  const key = match[0];
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    key,
    dayIndex: Math.floor(timestamp / 86400000),
  };
}

function toChicagoDateKey(isoTimestamp: string | null): { key: string; dayIndex: number } | null {
  if (!isoTimestamp) {
    return null;
  }

  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  const parts = CHICAGO_DATE_FORMATTER.formatToParts(date).reduce((values, part) => {
    if (part.type === "year" || part.type === "month" || part.type === "day") {
      values[part.type] = part.value;
    }
    return values;
  }, {} as Record<"year" | "month" | "day", string>);

  return parseDateKey(`${parts.year}-${parts.month}-${parts.day}`);
}

function buildHoldingPeriodBucket(params: {
  entryDate: string | null;
  exitTime: string | null;
  status: "open" | "closed" | string | null;
}): HoldingPeriodBucket {
  if (params.status === "open") {
    return "open";
  }

  const entryDate = parseDateKey(params.entryDate);
  const exitDate = toChicagoDateKey(params.exitTime);
  if (!entryDate || !exitDate) {
    return "unknown";
  }

  const dayDiff = exitDate.dayIndex - entryDate.dayIndex;
  if (dayDiff < 0) {
    return "unknown";
  }
  if (dayDiff === 0) {
    return "intraday";
  }
  if (dayDiff === 1) {
    return "overnight";
  }
  return "multi_day";
}

export function buildHoldingPeriodBucketForTest(params: {
  entryDate: string | null;
  exitTime: string | null;
  status?: "open" | "closed" | string | null;
}): HoldingPeriodBucket {
  return buildHoldingPeriodBucket({
    entryDate: params.entryDate,
    exitTime: params.exitTime,
    status: params.status ?? "closed",
  });
}

function toClosedTrades(trades: PaperDashboardTrade[]): PaperDashboardTrade[] {
  return trades.filter((trade) => asNumber(trade.review?.realized_pl_usd) !== null);
}

function buildBucket(key: string, label: string, trades: PaperDashboardTrade[]): PaperDashboardBucket {
  const closedTrades = toClosedTrades(trades);
  const openTrades = trades.filter((trade) => trade.status === "open");
  const winners = closedTrades.filter((trade) => trade.review?.winner === true);
  const losers = closedTrades.filter((trade) => trade.review?.winner === false);
  const realizedPl = closedTrades.reduce(
    (sum, trade) => sum + (asNumber(trade.review?.realized_pl_usd) ?? 0),
    0,
  );
  const rValues = closedTrades
    .map((trade) => asNumber(trade.review?.realized_r_multiple))
    .filter((value): value is number => value !== null);
  const returnPcts = closedTrades
    .map((trade) => asNumber(trade.review?.realized_return_pct))
    .filter((value): value is number => value !== null);

  return {
    key,
    label,
    trade_count: trades.length,
    open_trade_count: openTrades.length,
    closed_trade_count: closedTrades.length,
    open_position_cost_usd: openTrades.reduce(
      (sum, trade) => sum + (asNumber(trade.position_cost_usd) ?? 0),
      0,
    ),
    winner_count: winners.length,
    loser_count: losers.length,
    win_rate: closedTrades.length > 0 ? winners.length / closedTrades.length : null,
    realized_pl_usd: realizedPl,
    average_r_multiple: average(rValues),
    average_return_pct: average(returnPcts),
  };
}

function groupBy(
  trades: PaperDashboardTrade[],
  keyForTrade: (trade: PaperDashboardTrade) => { key: string; label: string },
): PaperDashboardBucket[] {
  const groups = trades.reduce((map, trade) => {
    const group = keyForTrade(trade);
    const existing = map.get(group.key) ?? { label: group.label, trades: [] as PaperDashboardTrade[] };
    existing.trades.push(trade);
    map.set(group.key, existing);
    return map;
  }, new Map<string, { label: string; trades: PaperDashboardTrade[] }>());

  return Array.from(groups.entries()).map(([key, group]) => buildBucket(key, group.label, group.trades));
}

function buildHoldingPeriodBuckets(trades: PaperDashboardTrade[]): PaperDashboardBucket[] {
  const sortIndex = (key: string): number => {
    const index = HOLDING_PERIOD_ORDER.indexOf(key as HoldingPeriodBucket);
    return index === -1 ? HOLDING_PERIOD_ORDER.length : index;
  };

  return groupBy(trades, (trade) => ({
    key: trade.holding_period_bucket,
    label: HOLDING_PERIOD_LABELS[trade.holding_period_bucket],
  })).sort((left, right) => sortIndex(left.key) - sortIndex(right.key));
}

export function buildHoldingPeriodBucketsForTest(
  trades: PaperDashboardHoldingPeriodBucketInput[],
): PaperDashboardBucket[] {
  return buildHoldingPeriodBuckets(trades.map((trade) => ({
    status: trade.status,
    holding_period_bucket: trade.holding_period_bucket,
    position_cost_usd: trade.position_cost_usd ?? null,
    review: trade.review
      ? {
          trade_id: "test-trade",
          winner: trade.review.winner ?? null,
          realized_pl_usd: trade.review.realized_pl_usd ?? null,
          realized_r_multiple: trade.review.realized_r_multiple ?? null,
          realized_return_pct: trade.review.realized_return_pct ?? null,
          review_notes: null,
        }
      : null,
  } as PaperDashboardTrade)));
}

function bestBucketLabel(buckets: PaperDashboardBucket[]): string | null {
  return buckets
    .filter((bucket) => bucket.closed_trade_count > 0)
    .sort((left, right) => right.realized_pl_usd - left.realized_pl_usd)[0]?.label ?? null;
}

function sortByLatestOutcomeDesc(left: PaperDashboardTrade, right: PaperDashboardTrade): number {
  const leftTime = left.latest_exit?.exit_time ?? left.created_at;
  const rightTime = right.latest_exit?.exit_time ?? right.created_at;
  return rightTime.localeCompare(leftTime);
}

function readAutomationLevel(
  signalSnapshot: Record<string, unknown> | null,
  key: "activeStopUnderlying" | "activeTargetUnderlying",
): number | null {
  const automation = asRecord(asRecord(signalSnapshot?.automation)?.paperTrader);
  return asNumber(automation?.[key]);
}

function buildSoldForUsd(exit: PaperDashboardExitRow | null): number | null {
  const optionExitPrice = asNumber(exit?.option_exit_price);
  const quantityClosed = asNumber(exit?.quantity_closed);
  if (optionExitPrice === null || quantityClosed === null) {
    return null;
  }
  return Number((optionExitPrice * quantityClosed * 100).toFixed(2));
}

function buildEmptyBrokerAudit(): PaperDashboardBrokerAudit {
  return {
    provisional_exit_count: 0,
    broker_confirmed_exit_count: 0,
    broker_repaired_exit_count: 0,
  };
}

export function buildPaperDashboardBrokerAuditForTest(
  exits: readonly PaperDashboardBrokerAuditExit[],
): PaperDashboardBrokerAudit {
  return exits.reduce((audit, exit) => {
    if (exit.exit_price_source === "provisional_quote") {
      audit.provisional_exit_count += 1;
    }
    if (exit.broker_confirmed === true) {
      audit.broker_confirmed_exit_count += 1;
    }
    if (exit.broker_repaired === true) {
      audit.broker_repaired_exit_count += 1;
    }
    return audit;
  }, buildEmptyBrokerAudit());
}

function isMissingExitTruthColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("42703")
    && (
      message.includes("exit_price_source")
      || message.includes("broker_confirmed")
      || message.includes("broker_repaired")
      || message.includes("broker_order_id")
    );
}

function addDefaultExitTruth(row: PaperDashboardLegacyExitRow): PaperDashboardExitRow {
  return {
    ...row,
    exit_price_source: "manual",
    broker_confirmed: false,
    broker_repaired: false,
    broker_order_id: null,
  };
}

export function addDefaultExitTruthForTest(row: PaperDashboardLegacyExitRow): PaperDashboardExitRow {
  return addDefaultExitTruth(row);
}

function buildOutcomeTrade(
  trade: PaperDashboardTrade,
  detail: PaperDashboardOutcomeDetailRow | null,
): PaperDashboardOutcomeTrade {
  const signalSnapshot = asRecord(detail?.signal_snapshot_json);
  const exitNotes = trade.latest_exit?.exit_notes ?? null;
  const exitPriceSource = trade.latest_exit?.exit_price_source ?? null;
  const isLoser = trade.review?.winner === false || ((asNumber(trade.review?.realized_pl_usd) ?? 0) < 0);
  return {
    id: trade.id,
    symbol: trade.symbol,
    direction: trade.direction,
    setup_type: trade.setup_type,
    entry_date: trade.entry_date,
    entry_time: trade.entry_time,
    entry_day: trade.entry_day,
    holding_period_bucket: trade.holding_period_bucket,
    exit_time: trade.latest_exit?.exit_time ?? null,
    exit_reason: trade.latest_exit?.exit_reason ?? null,
    contracts: asNumber(trade.contracts),
    position_cost_usd: asNumber(trade.position_cost_usd),
    underlying_entry_price: asNumber(trade.underlying_entry_price),
    option_entry_price: asNumber(trade.option_entry_price),
    option_exit_price: asNumber(trade.latest_exit?.option_exit_price),
    quantity_closed: asNumber(trade.latest_exit?.quantity_closed),
    sold_for_usd: buildSoldForUsd(trade.latest_exit),
    intended_stop_underlying: asNumber(trade.intended_stop_underlying),
    intended_target_underlying: asNumber(trade.intended_target_underlying),
    active_stop_underlying: readAutomationLevel(signalSnapshot, "activeStopUnderlying"),
    active_target_underlying: readAutomationLevel(signalSnapshot, "activeTargetUnderlying"),
    realized_pl_usd: asNumber(trade.review?.realized_pl_usd),
    realized_r_multiple: asNumber(trade.review?.realized_r_multiple),
    realized_return_pct: asNumber(trade.review?.realized_return_pct),
    entry_notes: trade.entry_notes,
    exit_notes: exitNotes,
    exit_price_source: exitPriceSource,
    broker_order_id: trade.latest_exit?.broker_order_id ?? null,
    review_notes: trade.review?.review_notes ?? null,
    provisional_exit: exitPriceSource === "provisional_quote",
    broker_confirmed_exit: trade.latest_exit?.broker_confirmed === true,
    broker_repaired_exit: trade.latest_exit?.broker_repaired === true,
    exits: trade.exits.map((exit) => ({
      exit_time: exit.exit_time,
      exit_reason: exit.exit_reason,
      option_exit_price: asNumber(exit.option_exit_price),
      quantity_closed: asNumber(exit.quantity_closed),
      exit_price_source: exit.exit_price_source,
      broker_confirmed: exit.broker_confirmed,
      broker_repaired: exit.broker_repaired,
    })),
    post_mortem: isLoser
      ? buildLossPostMortem({
          id: trade.id,
          account_mode: trade.account_mode,
          symbol: trade.symbol,
          direction: trade.direction,
          status: trade.status,
          contracts: asNumber(trade.contracts),
          position_cost_usd: trade.position_cost_usd,
          option_entry_price: trade.option_entry_price,
          planned_risk_usd: trade.planned_risk_usd,
          intended_stop_underlying: trade.intended_stop_underlying,
          intended_target_underlying: trade.intended_target_underlying,
          signal_snapshot_json: signalSnapshot,
          review: trade.review,
          exits: trade.exits,
        })
      : null,
    reasoning: buildReasoningSnapshot(signalSnapshot, trade.symbol),
  };
}

function buildEpochFilter(learningStartAt: string): string {
  return `created_at=gte.${learningStartAt}`;
}

function buildArchiveFilter(learningStartAt: string): string {
  return `created_at=lt.${learningStartAt}`;
}

async function countPaperDashboardRows(accountMode: AccountMode, filters: string[]): Promise<number> {
  return supabaseCount({
    table: "journal_trades",
    filters: [`account_mode=eq.${accountMode}`, ...filters],
  });
}

async function loadPaperDashboardExitRows(tradeIds: string[]): Promise<PaperDashboardExitRow[]> {
  try {
    return await supabaseSelect<PaperDashboardExitRow>({
      table: "journal_exits",
      select: "id,trade_id,exit_time,exit_reason,option_exit_price,quantity_closed,fees_usd,slippage_usd,exit_notes,exit_price_source,broker_confirmed,broker_repaired,broker_order_id",
      filters: [buildInFilter("trade_id", tradeIds)],
      order: ["exit_time.desc"],
    });
  } catch (error) {
    if (!isMissingExitTruthColumnError(error)) {
      throw error;
    }

    console.warn(
      "Paper dashboard exit-truth columns are missing; falling back to legacy journal_exits columns. Apply 202606180001_journal_exit_truth_fields.sql to enable structured broker/provisional counts.",
    );
    const legacyRows = await supabaseSelect<PaperDashboardLegacyExitRow>({
      table: "journal_exits",
      select: "id,trade_id,exit_time,exit_reason,option_exit_price,quantity_closed,fees_usd,slippage_usd,exit_notes",
      filters: [buildInFilter("trade_id", tradeIds)],
      order: ["exit_time.desc"],
    });
    return legacyRows.map(addDefaultExitTruth);
  }
}

async function loadPaperDashboardRows(
  accountMode: AccountMode,
  limit: number,
  filters: string[] = [],
): Promise<PaperDashboardTrade[]> {
  const tradeRows = await supabaseSelect<PaperDashboardTradeRow>({
    table: "journal_trades",
    select: "id,created_at,account_mode,entry_date,entry_time,symbol,direction,setup_type,status,contracts,position_cost_usd,underlying_entry_price,option_entry_price,planned_risk_usd,intended_stop_underlying,intended_target_underlying,entry_notes",
    filters: [`account_mode=eq.${accountMode}`, ...filters],
    order: ["entry_date.desc", "created_at.desc"],
    limit,
  });

  if (tradeRows.length === 0) {
    return [];
  }

  const tradeIds = tradeRows.map((trade) => trade.id);
  const [reviewRows, exitRows] = await Promise.all([
    supabaseSelect<PaperDashboardReviewRow>({
      table: "journal_reviews",
      select: "trade_id,winner,realized_pl_usd,realized_r_multiple,realized_return_pct,review_notes",
      filters: [buildInFilter("trade_id", tradeIds)],
    }),
    loadPaperDashboardExitRows(tradeIds),
  ]);

  const reviewsByTradeId = reviewRows.reduce((map, review) => {
    map.set(review.trade_id, review);
    return map;
  }, new Map<string, PaperDashboardReviewRow>());
  const latestExitsByTradeId = exitRows.reduce((map, exit) => {
    if (!map.has(exit.trade_id)) {
      map.set(exit.trade_id, exit);
    }
    return map;
  }, new Map<string, PaperDashboardExitRow>());
  const exitsByTradeId = exitRows.reduce((map, exit) => {
    const existing = map.get(exit.trade_id) ?? [];
    existing.push(exit);
    map.set(exit.trade_id, existing);
    return map;
  }, new Map<string, PaperDashboardExitRow[]>());

  return tradeRows.map((trade) => {
    const entryHourKey = buildEntryHourKey(trade.entry_time);
    const latestExit = latestExitsByTradeId.get(trade.id) ?? null;
    return {
      ...trade,
      entry_day: buildEntryDay(trade.entry_date),
      entry_hour_key: entryHourKey,
      entry_hour_label: buildEntryHourLabel(entryHourKey),
      holding_period_bucket: buildHoldingPeriodBucket({
        entryDate: trade.entry_date,
        exitTime: latestExit?.exit_time ?? null,
        status: trade.status,
      }),
      review: reviewsByTradeId.get(trade.id) ?? null,
      exits: exitsByTradeId.get(trade.id) ?? [],
      latest_exit: latestExit,
    };
  });
}

async function loadPaperDashboardOutcomeDetails(
  tradeIds: string[],
): Promise<Map<string, PaperDashboardOutcomeDetailRow>> {
  if (tradeIds.length === 0) {
    return new Map();
  }

  const rows = await supabaseSelect<PaperDashboardOutcomeDetailRow>({
    table: "journal_trades",
    select: "id,signal_snapshot_json",
    filters: [buildInFilter("id", tradeIds)],
  });

  return rows.reduce((map, row) => {
    map.set(row.id, row);
    return map;
  }, new Map<string, PaperDashboardOutcomeDetailRow>());
}

async function loadPaperDashboardLearningAudit(
  accountMode: AccountMode,
  limit: number,
): Promise<LearningOutcomeAudit> {
  try {
    const learningWindow = readPaperLearningWindow();
    const trades = await listJournalTradeDetails(limit, {
      accountMode,
      status: "closed",
      includeSignalSnapshot: true,
    });
    const currentEpochTrades = trades.filter((trade) => {
      const createdAtMs = Date.parse(trade.created_at);
      return !Number.isFinite(createdAtMs) || createdAtMs >= learningWindow.learningStartAtMs;
    });
    const warnings = trades.length >= limit
      ? [`Learning audit inspected the latest ${limit} closed ${accountMode} trade(s); older current-epoch rows may be omitted.`]
      : [];
    return buildLearningOutcomeAudit(currentEpochTrades, {
      accountMode,
      dataWarnings: warnings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildLearningOutcomeAudit([], {
      accountMode,
      dataWarnings: [`Learning audit unavailable: ${message}`],
    });
  }
}

export function buildEmptyPaperDashboard(
  dataWarnings: string[] = [],
  accountMode: AccountMode = "paper",
): PaperDashboard {
  const learningWindow = readPaperLearningWindow();
  return {
    dataWarnings,
    accountMode,
    learningStartAt: learningWindow.learningStartAt,
    includedTradeCount: 0,
    excludedTradeCount: 0,
    scopeLabel: CURRENT_EPOCH_SCOPE_LABEL,
    totals: {
      total_trades: 0,
      open_trades: 0,
      closed_trades: 0,
      open_position_cost_usd: 0,
      winners: 0,
      losers: 0,
      win_rate: null,
      total_realized_pl_usd: 0,
      average_r_multiple: null,
      average_return_pct: null,
      best_day_of_week: null,
      best_entry_time: null,
      best_setup_type: null,
    },
    by_day_of_week: [],
    by_entry_hour: [],
    by_direction: [],
    by_setup_type: [],
    by_symbol: [],
    by_exit_reason: [],
    by_holding_period: [],
    learning_audit: buildLearningOutcomeAudit([], { accountMode }),
    broker_audit: buildEmptyBrokerAudit(),
    outcome_details: {
      winners: [],
      losers: [],
      limit: PAPER_DASHBOARD_OUTCOME_DETAIL_LIMIT,
    },
  };
}

export async function getPaperDashboard(
  limit = 300,
  accountMode: AccountMode = "paper",
): Promise<PaperDashboard> {
  const learningWindow = readPaperLearningWindow();
  const epochFilter = buildEpochFilter(learningWindow.learningStartAt);
  const archiveFilter = buildArchiveFilter(learningWindow.learningStartAt);
  const metricLimit = Math.max(limit, PAPER_DASHBOARD_METRIC_LIMIT);
  const [trades, includedTradeCount, excludedTradeCount, learningAudit] = await Promise.all([
    loadPaperDashboardRows(accountMode, metricLimit, [epochFilter]),
    countPaperDashboardRows(accountMode, [epochFilter]),
    countPaperDashboardRows(accountMode, [archiveFilter]),
    loadPaperDashboardLearningAudit(accountMode, metricLimit),
  ]);
  const closedTrades = toClosedTrades(trades);
  const openTrades = trades.filter((trade) => trade.status === "open");
  const winners = closedTrades.filter((trade) => trade.review?.winner === true);
  const losers = closedTrades.filter((trade) => trade.review?.winner === false);
  const rValues = closedTrades
    .map((trade) => asNumber(trade.review?.realized_r_multiple))
    .filter((value): value is number => value !== null);
  const returnPcts = closedTrades
    .map((trade) => asNumber(trade.review?.realized_return_pct))
    .filter((value): value is number => value !== null);

  const byDay = WEEKDAY_ORDER.map((day) =>
    buildBucket(day.toLowerCase(), day, trades.filter((trade) => trade.entry_day === day)),
  ).filter((bucket) => bucket.trade_count > 0);
  const byEntryHour = groupBy(trades, (trade) => ({
    key: trade.entry_hour_key,
    label: trade.entry_hour_label,
  })).sort((left, right) => left.key.localeCompare(right.key));
  const byDirection = groupBy(trades, (trade) => ({
    key: trade.direction,
    label: trade.direction,
  })).sort((left, right) => left.label.localeCompare(right.label));
  const bySetup = groupBy(trades, (trade) => ({
    key: trade.setup_type,
    label: trade.setup_type,
  })).sort((left, right) => right.realized_pl_usd - left.realized_pl_usd);
  const bySymbol = groupBy(trades, (trade) => ({
    key: trade.symbol,
    label: trade.symbol,
  })).sort((left, right) => right.realized_pl_usd - left.realized_pl_usd).slice(0, 12);
  const byExitReason = groupBy(closedTrades, (trade) => ({
    key: trade.latest_exit?.exit_reason ?? "unknown",
    label: trade.latest_exit?.exit_reason ?? "unknown",
  })).sort((left, right) => right.realized_pl_usd - left.realized_pl_usd);
  const byHoldingPeriod = buildHoldingPeriodBuckets(trades);
  const outcomeWinnerTrades = winners
    .sort(sortByLatestOutcomeDesc)
    .slice(0, PAPER_DASHBOARD_OUTCOME_DETAIL_LIMIT);
  const outcomeLoserTrades = losers
    .sort(sortByLatestOutcomeDesc)
    .slice(0, PAPER_DASHBOARD_OUTCOME_DETAIL_LIMIT);
  const outcomeDetailsById = await loadPaperDashboardOutcomeDetails(
    [...outcomeWinnerTrades, ...outcomeLoserTrades].map((trade) => trade.id),
  );
  const brokerAudit = buildPaperDashboardBrokerAuditForTest(
    closedTrades.flatMap((trade) => trade.latest_exit ?? []),
  );

  return {
    dataWarnings: includedTradeCount > trades.length
      ? [`Dashboard is showing the latest ${trades.length} current-epoch ${accountMode} trades out of ${includedTradeCount}.`]
      : [],
    accountMode,
    learningStartAt: learningWindow.learningStartAt,
    includedTradeCount,
    excludedTradeCount,
    scopeLabel: CURRENT_EPOCH_SCOPE_LABEL,
    totals: {
      total_trades: trades.length,
      open_trades: openTrades.length,
      closed_trades: closedTrades.length,
      open_position_cost_usd: openTrades.reduce(
        (sum, trade) => sum + (asNumber(trade.position_cost_usd) ?? 0),
        0,
      ),
      winners: winners.length,
      losers: losers.length,
      win_rate: closedTrades.length > 0 ? winners.length / closedTrades.length : null,
      total_realized_pl_usd: closedTrades.reduce(
        (sum, trade) => sum + (asNumber(trade.review?.realized_pl_usd) ?? 0),
        0,
      ),
      average_r_multiple: average(rValues),
      average_return_pct: average(returnPcts),
      best_day_of_week: bestBucketLabel(byDay),
      best_entry_time: bestBucketLabel(byEntryHour),
      best_setup_type: bestBucketLabel(bySetup),
    },
    by_day_of_week: byDay,
    by_entry_hour: byEntryHour,
    by_direction: byDirection,
    by_setup_type: bySetup,
    by_symbol: bySymbol,
    by_exit_reason: byExitReason,
    by_holding_period: byHoldingPeriod,
    learning_audit: learningAudit,
    broker_audit: brokerAudit,
    outcome_details: {
      winners: outcomeWinnerTrades.map((trade) =>
        buildOutcomeTrade(trade, outcomeDetailsById.get(trade.id) ?? null)
      ),
      losers: outcomeLoserTrades.map((trade) =>
        buildOutcomeTrade(trade, outcomeDetailsById.get(trade.id) ?? null)
      ),
      limit: PAPER_DASHBOARD_OUTCOME_DETAIL_LIMIT,
    },
  };
}
