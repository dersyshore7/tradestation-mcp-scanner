import {
  supabaseInsertAndSelectOne,
  supabaseSelect,
  supabaseUpdateAndSelectOne,
} from "../supabase/serverClient.js";
import type {
  TradeRecommendationCreateInput,
  TradeRecommendationRecord,
} from "./types.js";

export async function createTradeRecommendation(
  input: TradeRecommendationCreateInput,
): Promise<TradeRecommendationRecord> {
  return await supabaseInsertAndSelectOne<TradeRecommendationRecord>({
    table: "trade_recommendations",
    values: {
      scan_run_id: input.scan_run_id,
      prompt: input.prompt,
      symbol: input.planned_trade.symbol,
      direction: input.planned_trade.direction,
      confidence_bucket: input.planned_trade.confidence_bucket ?? null,
      planned_trade_json: input.planned_trade,
      signal_snapshot_json: input.signal_snapshot_json,
    },
  });
}

export async function listRecentTradeRecommendations(limit = 25): Promise<TradeRecommendationRecord[]> {
  return await supabaseSelect<TradeRecommendationRecord>({
    table: "trade_recommendations",
    select: "*",
    order: ["created_at.desc"],
    limit,
  });
}

export async function markTradeRecommendationJournaled(
  id: string,
  journalTradeId: string,
): Promise<TradeRecommendationRecord> {
  return await supabaseUpdateAndSelectOne<TradeRecommendationRecord>({
    table: "trade_recommendations",
    filters: [`id=eq.${id}`],
    values: {
      journal_trade_id: journalTradeId,
    },
  });
}
