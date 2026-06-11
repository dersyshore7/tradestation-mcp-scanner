import { readPaperLearningWindow } from "../automation/paperLearningCutoff.js";
import { buildReasoningSnapshot } from "./insights.js";
import { supabaseCount, supabaseSelect } from "../supabase/serverClient.js";
import type { AccountMode, JournalReasoningSnapshot } from "./types.js";

const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CURRENT_EPOCH_SCOPE_LABEL = "Current learning epoch" as const;
const PAPER_DASHBOARD_METRIC_LIMIT = 5000;
const PAPER_DASHBOARD_OUTCOME_DETAIL_LIMIT = 50;

type NumericValue = number | string | null;

type PaperDashboardTradeRow = {
  id: string;
  created_at: string;
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
  trade_id: string;
  exit_time: string;
  exit_reason: string;
  option_exit_price: NumericValue;
  quantity_closed: number;
  exit_notes: string | null;
};

type PaperDashboardOutcomeDetailRow = {
  id: string;
  signal_snapshot_json: Record<string, unknown> | null;
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
  review_notes: string | null;
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
  review: PaperDashboardReviewRow | null;
  latest_exit: PaperDashboardExitRow | null;
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

function buildOutcomeTrade(
  trade: PaperDashboardTrade,
  detail: PaperDashboardOutcomeDetailRow | null,
): PaperDashboardOutcomeTrade {
  const signalSnapshot = asRecord(detail?.signal_snapshot_json);
  return {
    id: trade.id,
    symbol: trade.symbol,
    direction: trade.direction,
    setup_type: trade.setup_type,
    entry_date: trade.entry_date,
    entry_time: trade.entry_time,
    entry_day: trade.entry_day,
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
    exit_notes: trade.latest_exit?.exit_notes ?? null,
    review_notes: trade.review?.review_notes ?? null,
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

async function loadPaperDashboardRows(
  accountMode: AccountMode,
  limit: number,
  filters: string[] = [],
): Promise<PaperDashboardTrade[]> {
  const tradeRows = await supabaseSelect<PaperDashboardTradeRow>({
    table: "journal_trades",
    select: "id,created_at,entry_date,entry_time,symbol,direction,setup_type,status,contracts,position_cost_usd,underlying_entry_price,option_entry_price,intended_stop_underlying,intended_target_underlying,entry_notes",
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
    supabaseSelect<PaperDashboardExitRow>({
      table: "journal_exits",
      select: "trade_id,exit_time,exit_reason,option_exit_price,quantity_closed,exit_notes",
      filters: [buildInFilter("trade_id", tradeIds)],
      order: ["exit_time.desc"],
    }),
  ]);

  const reviewsByTradeId = reviewRows.reduce((map, review) => {
    map.set(review.trade_id, review);
    return map;
  }, new Map<string, PaperDashboardReviewRow>());
  const exitsByTradeId = exitRows.reduce((map, exit) => {
    if (!map.has(exit.trade_id)) {
      map.set(exit.trade_id, exit);
    }
    return map;
  }, new Map<string, PaperDashboardExitRow>());

  return tradeRows.map((trade) => {
    const entryHourKey = buildEntryHourKey(trade.entry_time);
    return {
      ...trade,
      entry_day: buildEntryDay(trade.entry_date),
      entry_hour_key: entryHourKey,
      entry_hour_label: buildEntryHourLabel(entryHourKey),
      review: reviewsByTradeId.get(trade.id) ?? null,
      latest_exit: exitsByTradeId.get(trade.id) ?? null,
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
  const [trades, includedTradeCount, excludedTradeCount] = await Promise.all([
    loadPaperDashboardRows(accountMode, metricLimit, [epochFilter]),
    countPaperDashboardRows(accountMode, [epochFilter]),
    countPaperDashboardRows(accountMode, [archiveFilter]),
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
  const outcomeWinnerTrades = winners
    .sort(sortByLatestOutcomeDesc)
    .slice(0, PAPER_DASHBOARD_OUTCOME_DETAIL_LIMIT);
  const outcomeLoserTrades = losers
    .sort(sortByLatestOutcomeDesc)
    .slice(0, PAPER_DASHBOARD_OUTCOME_DETAIL_LIMIT);
  const outcomeDetailsById = await loadPaperDashboardOutcomeDetails(
    [...outcomeWinnerTrades, ...outcomeLoserTrades].map((trade) => trade.id),
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
