import { supabaseInsertAndSelectOne, supabaseSelect } from "../supabase/serverClient.js";
import type { JournalTradeCreateInput, JournalTradeListItem, JournalTradeRecord } from "./types.js";

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

export async function createJournalTrade(input: JournalTradeCreateInput): Promise<JournalTradeRecord> {
  const { planned_trade: planned, signal_snapshot_json, ...entry } = input;

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
    position_cost_usd: planned.position_cost_usd,
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
  const data = await supabaseSelect<Omit<JournalTradeListItem, "entry_day" | "entry_week">>({
    table: "journal_trades",
    select: "id,created_at,entry_date,symbol,direction,setup_type,status,account_mode,position_cost_usd,option_entry_price",
    order: ["entry_date.desc", "created_at.desc"],
    limit,
  });

  return (data ?? []).map((trade) => ({
    ...(trade as Omit<JournalTradeListItem, "entry_day" | "entry_week">),
    entry_day: buildEntryDay(String(trade.entry_date)),
    entry_week: buildEntryWeek(String(trade.entry_date)),
  }));
}

export async function getJournalTradeById(id: string): Promise<JournalTradeRecord | null> {
  const data = await supabaseSelect<JournalTradeRecord>({
    table: "journal_trades",
    select: "*",
    filters: [`id=eq.${id}`],
    single: "maybeSingle",
  });
  return data[0] ?? null;
}
