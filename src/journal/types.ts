export const ACCOUNT_MODES = ["paper", "live"] as const;
export const TRADE_DIRECTIONS = ["CALL", "PUT"] as const;
export const TRADE_STATUSES = ["open", "closed"] as const;

export type AccountMode = (typeof ACCOUNT_MODES)[number];
export type TradeDirection = (typeof TRADE_DIRECTIONS)[number];
export type TradeStatus = (typeof TRADE_STATUSES)[number];

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

export type JournalTradeListItem = Pick<
  JournalTradeRecord,
  "id" | "created_at" | "entry_date" | "symbol" | "direction" | "setup_type" | "status" | "account_mode" | "position_cost_usd" | "option_entry_price"
> & {
  entry_day: string;
  entry_week: string;
};
