import type {
  JournalInsightBucket,
  JournalInsights,
  JournalReasoningComparisonItem,
  JournalReasoningSnapshot,
  JournalTradeDetail,
} from "./types.js";

const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type JournalInsightBuildOptions = {
  reasoningIncluded?: boolean;
};

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

function buildTechnicalSnapshot(params: {
  savedReasoning: Record<string, unknown> | null;
  geometry: Record<string, unknown> | null;
  stage3PassedDetail: unknown;
  rankingDetail: unknown;
  reviewedOutcome: unknown;
  finalistsDebugDetail: unknown;
}): JournalReasoningSnapshot["technical_snapshot"] {
  const savedTechnical = asRecord(params.savedReasoning?.technical_snapshot);
  const rankingInputs = asRecord(asRecord(params.rankingDetail)?.scoreInputs);
  const finalistsDebug = asRecord(params.finalistsDebugDetail);
  const stage3PassedDetail = asRecord(params.stage3PassedDetail);
  const reviewedOutcome = asRecord(params.reviewedOutcome);

  const technicalSnapshot: JournalReasoningSnapshot["technical_snapshot"] = {
    stage3_direction:
      asString(savedTechnical?.stage3_direction) ??
      asString(stage3PassedDetail?.direction) ??
      asString(reviewedOutcome?.direction),
    move_pct:
      asNumber(savedTechnical?.move_pct) ??
      asNumber(rankingInputs?.movePct),
    volume_ratio:
      asNumber(savedTechnical?.volume_ratio) ??
      asNumber(rankingInputs?.volumeRatio),
    chart_review_score:
      asNumber(savedTechnical?.chart_review_score) ??
      asNumber(rankingInputs?.chartReviewScore),
    stage3_summary:
      asString(savedTechnical?.stage3_summary) ??
      asString(stage3PassedDetail?.summary),
    candlestick_checks:
      asString(savedTechnical?.candlestick_checks) ??
      asString(stage3PassedDetail?.whyPassed),
    option_open_interest:
      asNumber(savedTechnical?.option_open_interest) ??
      asNumber(rankingInputs?.optionOpenInterest),
    option_spread:
      asNumber(savedTechnical?.option_spread) ??
      asNumber(rankingInputs?.optionSpread),
    option_mid:
      asNumber(savedTechnical?.option_mid) ??
      asNumber(rankingInputs?.optionMid),
    continuation_penalty:
      asNumber(savedTechnical?.continuation_penalty) ??
      asNumber(rankingInputs?.continuationPenalty),
    final_invalidation:
      asString(savedTechnical?.final_invalidation) ??
      asString(params.geometry?.invalidation),
    final_target:
      asString(savedTechnical?.final_target) ??
      asString(params.geometry?.target),
    support_or_invalidation:
      asString(savedTechnical?.support_or_invalidation) ??
      asString(finalistsDebug?.preReviewInvalReason),
    resistance_or_target:
      asString(savedTechnical?.resistance_or_target) ??
      asString(finalistsDebug?.preReviewTargetReason),
    final_chart_reward_risk:
      asString(savedTechnical?.final_chart_reward_risk) ??
      asString(params.geometry?.finalChartRewardRisk),
  };

  const hasAnyValue = Object.values(technicalSnapshot).some((value) => value !== null);
  return hasAnyValue ? technicalSnapshot : null;
}

function buildReasoningSnapshot(signalSnapshot: Record<string, unknown> | null, symbol: string): JournalReasoningSnapshot | null {
  if (!signalSnapshot) {
    return null;
  }

  const savedReasoning = asRecord(signalSnapshot.reasoningSnapshot);
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
  const finalistsDebugDetail = Array.isArray(telemetry?.finalistsReviewedDebug)
    ? telemetry.finalistsReviewedDebug.find((item) => asRecord(item)?.symbol === symbol)
    : null;
  const geometry = asRecord(savedReasoning?.chart_geometry) ?? asRecord(presentationSummary?.finalChartGeometry);
  const savedConfirmationFailureReasons = asStringArray(savedReasoning?.confirmation_failure_reasons);
  const fallbackConfirmationFailureReasons = asStringArray(asRecord(reviewedOutcome)?.confirmationFailureReasons);

  return {
    scan_reason: asString(savedReasoning?.scan_reason) ?? asString(scan?.reason),
    concise_reasoning: asString(savedReasoning?.concise_reasoning) ?? asString(presentationSummary?.conciseReasoning),
    why_this_won: asString(savedReasoning?.why_this_won) ?? asString(presentationSummary?.whyThisWon),
    chart_geometry: geometry
      ? {
          direction: asString(geometry.direction) ?? "n/a",
          reference: asString(geometry.reference) ?? "n/a",
          invalidation: asString(geometry.invalidation) ?? "n/a",
          target: asString(geometry.target) ?? "n/a",
          final_chart_reward_risk:
            asString(geometry.final_chart_reward_risk) ??
            asString(geometry.finalChartRewardRisk) ??
            "n/a",
          structure: asString(geometry.structure) ?? "n/a",
        }
      : null,
    review_ladder: asReviewLadder(savedReasoning?.review_ladder ?? presentationSummary?.reviewLadder),
    stage3_summary: asString(savedReasoning?.stage3_summary) ?? asString(asRecord(stage3PassedDetail)?.summary),
    stage3_why_passed: asString(savedReasoning?.stage3_why_passed) ?? asString(asRecord(stage3PassedDetail)?.whyPassed),
    review_outcome_reason: asString(savedReasoning?.review_outcome_reason) ?? asString(asRecord(reviewedOutcome)?.reason),
    confirmation_failure_reasons:
      savedConfirmationFailureReasons.length > 0 ? savedConfirmationFailureReasons : fallbackConfirmationFailureReasons,
    volume_ratio:
      asNumber(savedReasoning?.volume_ratio) ??
      asNumber(asRecord(asRecord(rankingDetail)?.scoreInputs)?.volumeRatio),
    chart_review_score:
      asNumber(savedReasoning?.chart_review_score) ??
      asNumber(asRecord(asRecord(rankingDetail)?.scoreInputs)?.chartReviewScore),
    expected_timing: asString(savedReasoning?.expected_timing) ?? asString(tradeCard?.expectedTiming),
    trade_rationale: asString(savedReasoning?.trade_rationale) ?? asString(tradeCard?.rationale),
    technical_snapshot: buildTechnicalSnapshot({
      savedReasoning,
      geometry,
      stage3PassedDetail,
      rankingDetail,
      reviewedOutcome,
      finalistsDebugDetail,
    }),
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
  const openTrades = trades.filter((trade) => trade.status === "open");
  const winners = closedTrades.filter((trade) => trade.review?.winner === true);
  const losers = closedTrades.filter((trade) => trade.review?.winner === false);
  const totalPl = closedTrades.reduce((sum, trade) => sum + (toNumber(trade.review?.realized_pl_usd ?? null) ?? 0), 0);
  const openPositionCost = openTrades.reduce((sum, trade) => sum + (toNumber(trade.position_cost_usd) ?? 0), 0);
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
    open_trade_count: openTrades.length,
    closed_trade_count: closedTrades.length,
    open_position_cost_usd: openPositionCost,
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

export function buildJournalInsights(
  trades: JournalTradeDetail[],
  options: JournalInsightBuildOptions = {},
): JournalInsights {
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

  const accountModeBuckets = Array.from(
    trades.reduce((map, trade) => {
      const existing = map.get(trade.account_mode) ?? [];
      existing.push(trade);
      map.set(trade.account_mode, existing);
      return map;
    }, new Map<string, JournalTradeDetail[]>()),
  )
    .map(([accountMode, modeTrades]) => buildBucket(accountMode, accountMode, modeTrades))
    .sort((left, right) => left.label.localeCompare(right.label));

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
  const openPositionCost = trades
    .filter((trade) => trade.status === "open")
    .reduce((sum, trade) => sum + (toNumber(trade.position_cost_usd) ?? 0), 0);
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
    reasoning_included: options.reasoningIncluded === true,
    totals: {
      total_trades: trades.length,
      open_trades: trades.filter((trade) => trade.status === "open").length,
      closed_trades: closedTrades.length,
      open_position_cost_usd: openPositionCost,
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
    by_account_mode: accountModeBuckets,
    by_setup_type: setupBuckets,
    by_symbol: symbolBuckets,
    recent_winners: winners.sort(sortByLatestExitDesc).slice(0, 5).map(buildReasoningComparisonItem),
    recent_losers: losers.sort(sortByLatestExitDesc).slice(0, 5).map(buildReasoningComparisonItem),
  };
}
