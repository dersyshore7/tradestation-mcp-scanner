import type { PlannedTradeSnapshot } from "../journal/types.js";

export type TradeRecommendationRecord = {
  id: string;
  created_at: string;
  updated_at: string;
  scan_run_id: string;
  prompt: string | null;
  symbol: string;
  direction: PlannedTradeSnapshot["direction"];
  confidence_bucket: string | null;
  planned_trade_json: PlannedTradeSnapshot;
  signal_snapshot_json: Record<string, unknown> | null;
  journal_trade_id: string | null;
};

export type TradeRecommendationCreateInput = {
  scan_run_id: string;
  prompt: string;
  planned_trade: PlannedTradeSnapshot;
  signal_snapshot_json: Record<string, unknown>;
};
