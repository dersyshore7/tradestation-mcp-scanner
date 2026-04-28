export const ACCOUNT_MODES = ["paper", "live"] as const;
export const TRADE_DIRECTIONS = ["CALL", "PUT"] as const;
export const TRADE_STATUSES = ["open", "closed"] as const;
export const JOURNAL_EXIT_REASONS = [
  "target_hit",
  "stop_hit",
  "time_exit",
  "manual_early_exit",
  "rule_violation",
  "partial_profit",
  "other",
] as const;

export type AccountMode = (typeof ACCOUNT_MODES)[number];
export type TradeDirection = (typeof TRADE_DIRECTIONS)[number];
export type TradeStatus = (typeof TRADE_STATUSES)[number];
export type JournalExitReason = (typeof JOURNAL_EXIT_REASONS)[number];

export type PlannedTradeSnapshot = {
  scan_run_id?: string | null;
  symbol: string;
  direction: TradeDirection;
  expiration_date?: string | null;
  dte_at_entry?: number | null;
  position_cost_usd: number;
  underlying_entry_price?: number | null;
  planned_risk_usd?: number | null;
  planned_profit_usd?: number | null;
  setup_type: string;
  setup_subtype?: string | null;
  confidence_bucket?: string | null;
  intended_stop_underlying?: number | null;
  intended_target_underlying?: number | null;
  market_regime?: string | null;
};

export type JournalTradeCreateInput = {
  account_mode: AccountMode;
  entry_date: string;
  entry_time?: string | null;
  contracts?: number | null;
  option_entry_price?: number | null;
  entry_notes?: string | null;
  planned_trade: PlannedTradeSnapshot;
  signal_snapshot_json?: Record<string, unknown> | null;
  status?: TradeStatus;
};

export type JournalTradeCloseInput = {
  option_exit_price?: number | null;
  sold_for_usd?: number | null;
  exit_reason: JournalExitReason;
  exit_timestamp: string;
  quantity_closed?: number | null;
  fees_usd?: number | null;
  slippage_usd?: number | null;
  exit_notes?: string | null;
  lessons_learned?: string | null;
  review_notes?: string | null;
};

export type JournalTradeUpdateInput = {
  account_mode?: AccountMode;
  entry_date?: string;
  entry_time?: string | null;
  contracts?: number | null;
  option_entry_price?: number | null;
  entry_notes?: string | null;
  option_exit_price?: number | null;
  quantity_closed?: number | null;
  exit_reason?: JournalExitReason;
  exit_timestamp?: string;
  lessons_learned?: string | null;
  review_notes?: string | null;
};

export type JournalTradeRecord = {
  id: string;
  created_at: string;
  updated_at: string;
  scan_run_id: string | null;
  account_mode: AccountMode;
  entry_date: string;
  entry_time: string | null;
  symbol: string;
  direction: TradeDirection;
  expiration_date: string | null;
  dte_at_entry: number | null;
  contracts: number | null;
  position_cost_usd: string;
  underlying_entry_price: string | null;
  option_entry_price: string | null;
  planned_risk_usd: string | null;
  planned_profit_usd: string | null;
  setup_type: string;
  setup_subtype: string | null;
  confidence_bucket: string | null;
  intended_stop_underlying: string | null;
  intended_target_underlying: string | null;
  market_regime: string | null;
  signal_snapshot_json: Record<string, unknown> | null;
  entry_notes: string | null;
  status: TradeStatus;
};

export type JournalTradeExitRecord = {
  id: string;
  trade_id: string;
  exit_time: string;
  option_exit_price: string;
  quantity_closed: number;
  exit_reason: JournalExitReason;
  fees_usd: string;
  slippage_usd: string;
  exit_notes: string | null;
};

export type JournalTradeReviewRecord = {
  trade_id: string;
  followed_plan: boolean | null;
  winner: boolean | null;
  realized_pl_usd: string | null;
  realized_r_multiple: string | null;
  realized_return_pct: string | null;
  rule_break_tags: string[];
  review_grade: "A" | "B" | "C" | "D" | "F" | null;
  mistake_category: string | null;
  lessons_learned: string | null;
  review_notes: string | null;
};

export type JournalTradeDetail = JournalTradeRecord & {
  entry_day: string;
  entry_week: string;
  exits: JournalTradeExitRecord[];
  latest_exit: JournalTradeExitRecord | null;
  review: JournalTradeReviewRecord | null;
  sold_for_usd: string | null;
};

export type JournalTradeListItem = Pick<
  JournalTradeRecord,
  "id" | "created_at" | "entry_date" | "symbol" | "direction" | "setup_type" | "status" | "account_mode" | "position_cost_usd" | "option_entry_price" | "contracts"
> & {
  entry_day: string;
  entry_week: string;
  exit_option_price: string | null;
  sold_for_usd: string | null;
  realized_pl_usd: string | null;
  realized_r_multiple: string | null;
  realized_return_pct: string | null;
  winner: boolean | null;
  latest_exit_reason: JournalExitReason | null;
};

export type JournalReasoningSnapshot = {
  scan_reason: string | null;
  concise_reasoning: string | null;
  why_this_won: string | null;
  chart_geometry: {
    direction: string;
    reference: string;
    invalidation: string;
    target: string;
    final_chart_reward_risk: string;
    structure: string;
  } | null;
  review_ladder: {
    symbol: string;
    outcome: string;
    detail: string;
  }[];
  stage3_summary: string | null;
  stage3_why_passed: string | null;
  review_outcome_reason: string | null;
  confirmation_failure_reasons: string[];
  volume_ratio: number | null;
  chart_review_score: number | null;
  expected_timing: string | null;
  trade_rationale: string | null;
  technical_snapshot: {
    stage3_direction: string | null;
    move_pct: number | null;
    volume_ratio: number | null;
    chart_review_score: number | null;
    stage3_summary: string | null;
    candlestick_checks: string | null;
    option_open_interest: number | null;
    option_spread: number | null;
    option_mid: number | null;
    continuation_penalty: number | null;
    final_invalidation: string | null;
    final_target: string | null;
    support_or_invalidation: string | null;
    resistance_or_target: string | null;
    final_chart_reward_risk: string | null;
  } | null;
};

export type JournalInsightBucket = {
  key: string;
  label: string;
  trade_count: number;
  closed_trade_count: number;
  winner_count: number;
  loser_count: number;
  win_rate: number | null;
  realized_pl_usd: number;
  average_r_multiple: number | null;
  average_return_pct: number | null;
};

export type JournalReasoningComparisonItem = {
  id: string;
  symbol: string;
  entry_date: string;
  setup_type: string;
  exit_reason: JournalExitReason | null;
  realized_pl_usd: number | null;
  realized_r_multiple: number | null;
  winner: boolean | null;
  entry_notes: string | null;
  review_notes: string | null;
  reasoning: JournalReasoningSnapshot | null;
};

export type JournalInsights = {
  totals: {
    total_trades: number;
    open_trades: number;
    closed_trades: number;
    winners: number;
    losers: number;
    win_rate: number | null;
    total_realized_pl_usd: number;
    average_r_multiple: number | null;
    average_return_pct: number | null;
    best_day_of_week: string | null;
    best_setup_type: string | null;
  };
  by_day_of_week: JournalInsightBucket[];
  by_setup_type: JournalInsightBucket[];
  by_symbol: JournalInsightBucket[];
  recent_winners: JournalReasoningComparisonItem[];
  recent_losers: JournalReasoningComparisonItem[];
};
