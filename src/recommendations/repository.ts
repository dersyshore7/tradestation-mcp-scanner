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
): Promise<TradeRecommendationRecord | null> {
  try {
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
  } catch (error) {
    if (isTradeRecommendationsTableMissing(error)) {
      return null;
    }
    throw error;
  }
}

export type TradeRecommendationListResult = {
  recommendations: TradeRecommendationRecord[];
  migrationRequired: boolean;
  migrationMessage: string | null;
};

export function isTradeRecommendationsTableMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("PGRST205") &&
    message.includes("trade_recommendations")
  ) || (
    message.toLowerCase().includes("could not find the table") &&
    message.includes("trade_recommendations")
  );
}

export async function listRecentTradeRecommendations(limit = 25): Promise<TradeRecommendationListResult> {
  try {
    const recommendations = await supabaseSelect<TradeRecommendationRecord>({
      table: "trade_recommendations",
      select: "*",
      order: ["created_at.desc"],
      limit,
    });

    return {
      recommendations,
      migrationRequired: false,
      migrationMessage: null,
    };
  } catch (error) {
    if (!isTradeRecommendationsTableMissing(error)) {
      throw error;
    }

    return {
      recommendations: [],
      migrationRequired: true,
      migrationMessage:
        "Supabase is missing the trade_recommendations table. Apply supabase/migrations/202604280001_trade_recommendations.sql to enable saved recommendation history.",
    };
  }
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
