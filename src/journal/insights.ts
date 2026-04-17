import type {
  JournalInsightBucket,
  JournalInsights,
  JournalReasoningComparisonItem,
  JournalReasoningSnapshot,
  JournalTradeDetail,
} from "./types.js";

const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asString(item))
    .filter((item): item is string => item !== null);
}

function asReviewLadder(value: unknown): JournalReasoningSnapshot["review_ladder"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const record = asRecord(item);
      if (!record) {
        return null;
      }

      const symbol = asString(record.symbol);
      const outcome = asString(record.outcome);
      const detail = asString(record.detail);
      if (!symbol || !outcome || !detail) {
        return null;
      }

      return { symbol, outcome, detail };
    })
    .filter((item): item is JournalReasoningSnapshot["review_ladder"][number] => item !== null);
}

function buildReasoningSnapshot(signalSnapshot: Record<string, unknown> | null, symbol: string): JournalReasoningSnapshot | null {
  if (!signalSnapshot) {
    return null;
  }

  const scan = asRecord(signalSnapshot.scan);
  const tradeCard = asRecord(signalSnapshot.tradeCard);
  const presentationSummary = asRecord(signalSnapshot.presentationSummary);
  const telemetry = asRecord(
    (scan && isRecord(scan.telemetry) ? scan.telemetry : null) ??
      (isRecord(signalSnapshot.telemetry) ? signalSnapshot.telemetry : null),
  );

  const stage3PassedDetail = Array.isArray(telemetry?.stage3PassedDetails)
    ? telemetry.stage3PassedDetails.find((item) => asRecord(item)?.symbol === symbol)
    : null;
  const rankingDetail = Array.isArray(telemetry?.finalRankingDebug)
    ? telemetry.finalRankingDebug.find((item) => asRecord(item)?.symbol === symbol)
    : null;
  const reviewedOutcome = Array.isArray(telemetry?.reviewedFinalistOutcomes)
    ? telemetry.reviewedFinalistOutcomes.find((item) => asRecord(item)?.symbol === symbol)
    : null;
  const geometry = asRecord(presentationSummary?.finalChartGeometry);

  return {
    scan_reason: asString(scan?.reason),
    concise_reasoning: asString(presentationSummary?.conciseReasoning),
    why_this_won: asString(presentationSummary?.whyThisWon),
    chart_geometry: geometry
      ? {
          direction: asString(geometry.direction) ?? "n/a",
          reference: asString(geometry.reference) ?? "n/a",
          invalidation: asString(geometry.invalidation) ?? "n/a",
          target: asString(geometry.target) ?? "n/a",
          final_chart_reward_risk: asString(geometry.finalChartRewardRisk) ?? "n/a",
          structure: asString(geometry.structure) ?? "n/a",
        }
      : null,
    review_ladder: asReviewLadder(presentationSummary?.reviewLadder),
    stage3_summary: asString(asRecord(stage3PassedDetail)?.summary),
    stage3_why_passed: asString(asRecord(stage3PassedDetail)?.whyPassed),
    review_outcome_reason: asString(asRecord(reviewedOutcome)?.reason),
    confirmation_failure_reasons: asStringArray(asRecord(reviewedOutcome)?.confirmationFailureReasons),
    volume_ratio: asNumber(asRecord(asRecord(rankingDetail)?.scoreInputs)?.volumeRatio),
    chart_review_score: asNumber(asRecord(asRecord(rankingDetail)?.scoreInputs)?.chartReviewScore),
    expected_timing: asString(tradeCard?.expectedTiming),
    trade_rationale: asString(tradeCard?.rationale),
  };
}

function toNumber(value: string | null): number | null {
  return value === null ? null : asNumber(value);
}

function toClosedTrades(trades: JournalTradeDetail[]): JournalTradeDetail[] {
  return trades.filter((trade) => trade.review?.realized_pl_usd !== null);
}

function buildBucket(key: string, label: string, trades: JournalTradeDetail[]): JournalInsightBucket {
  const closedTrades = toClosedTrades(trades);
  const winners = closedTrades.filter((trade) => trade.review?.winner === true);
  const losers = closedTrades.filter((trade) => trade.review?.winner === false);
  const totalPl = closedTrades.reduce((sum, trade) => sum + (toNumber(trade.review?.realized_pl_usd ?? null) ?? 0), 0);
  const rValues = closedTrades
    .map((trade) => toNumber(trade.review?.realized_r_multiple ?? null))
    .filter((value): value is number => value !== null);
  const returnPcts = closedTrades
    .map((trade) => toNumber(trade.review?.realized_return_pct ?? null))
    .filter((value): value is number => value !== null);

  return {
    key,
    label,
    trade_count: trades.length,
    closed_trade_count: closedTrades.length,
    winner_count: winners.length,
    loser_count: losers.length,
    win_rate: closedTrades.length > 0 ? winners.length / closedTrades.length : null,
    realized_pl_usd: totalPl,
    average_r_multiple: rValues.length > 0 ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null,
    average_return_pct: returnPcts.length > 0 ? returnPcts.reduce((sum, value) => sum + value, 0) / returnPcts.length : null,
  };
}

function buildReasoningComparisonItem(trade: JournalTradeDetail): JournalReasoningComparisonItem {
  return {
    id: trade.id,
    symbol: trade.symbol,
    entry_date: trade.entry_date,
    setup_type: trade.setup_type,
    exit_reason: trade.latest_exit?.exit_reason ?? null,
    realized_pl_usd: toNumber(trade.review?.realized_pl_usd ?? null),
    realized_r_multiple: toNumber(trade.review?.realized_r_multiple ?? null),
    winner: trade.review?.winner ?? null,
    entry_notes: trade.entry_notes,
    review_notes: trade.review?.review_notes ?? null,
    reasoning: buildReasoningSnapshot(trade.signal_snapshot_json, trade.symbol),
  };
}

export function buildJournalInsights(trades: JournalTradeDetail[]): JournalInsights {
  const closedTrades = toClosedTrades(trades);
  const winners = closedTrades.filter((trade) => trade.review?.winner === true);
  const losers = closedTrades.filter((trade) => trade.review?.winner === false);

  const weekdayBuckets = WEEKDAY_ORDER.map((day) =>
    buildBucket(day.toLowerCase(), day, trades.filter((trade) => trade.entry_day === day)),
  ).filter((bucket) => bucket.trade_count > 0);

  const setupBuckets = Array.from(
    trades.reduce((map, trade) => {
      const existing = map.get(trade.setup_type) ?? [];
      existing.push(trade);
      map.set(trade.setup_type, existing);
      return map;
    }, new Map<string, JournalTradeDetail[]>()),
  )
    .map(([setupType, setupTrades]) => buildBucket(setupType, setupType, setupTrades))
    .sort((left, right) => right.realized_pl_usd - left.realized_pl_usd);

  const symbolBuckets = Array.from(
    trades.reduce((map, trade) => {
      const existing = map.get(trade.symbol) ?? [];
      existing.push(trade);
      map.set(trade.symbol, existing);
      return map;
    }, new Map<string, JournalTradeDetail[]>()),
  )
    .map(([symbol, symbolTrades]) => buildBucket(symbol, symbol, symbolTrades))
    .sort((left, right) => right.realized_pl_usd - left.realized_pl_usd)
    .slice(0, 10);

  const totalPl = closedTrades.reduce((sum, trade) => sum + (toNumber(trade.review?.realized_pl_usd ?? null) ?? 0), 0);
  const rValues = closedTrades
    .map((trade) => toNumber(trade.review?.realized_r_multiple ?? null))
    .filter((value): value is number => value !== null);
  const returnPcts = closedTrades
    .map((trade) => toNumber(trade.review?.realized_return_pct ?? null))
    .filter((value): value is number => value !== null);

  const bestDay = weekdayBuckets
    .filter((bucket) => bucket.closed_trade_count > 0)
    .sort((left, right) => right.realized_pl_usd - left.realized_pl_usd)[0] ?? null;
  const bestSetup = setupBuckets
    .filter((bucket) => bucket.closed_trade_count > 0)
    .sort((left, right) => right.realized_pl_usd - left.realized_pl_usd)[0] ?? null;

  const sortByLatestExitDesc = (left: JournalTradeDetail, right: JournalTradeDetail): number => {
    const leftTime = left.latest_exit?.exit_time ?? left.updated_at;
    const rightTime = right.latest_exit?.exit_time ?? right.updated_at;
    return rightTime.localeCompare(leftTime);
  };

  return {
    totals: {
      total_trades: trades.length,
      open_trades: trades.filter((trade) => trade.status === "open").length,
      closed_trades: closedTrades.length,
      winners: winners.length,
      losers: losers.length,
      win_rate: closedTrades.length > 0 ? winners.length / closedTrades.length : null,
      total_realized_pl_usd: totalPl,
      average_r_multiple: rValues.length > 0 ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null,
      average_return_pct: returnPcts.length > 0 ? returnPcts.reduce((sum, value) => sum + value, 0) / returnPcts.length : null,
      best_day_of_week: bestDay?.label ?? null,
      best_setup_type: bestSetup?.label ?? null,
    },
    by_day_of_week: weekdayBuckets,
    by_setup_type: setupBuckets,
    by_symbol: symbolBuckets,
    recent_winners: winners.sort(sortByLatestExitDesc).slice(0, 5).map(buildReasoningComparisonItem),
    recent_losers: losers.sort(sortByLatestExitDesc).slice(0, 5).map(buildReasoningComparisonItem),
  };
}
