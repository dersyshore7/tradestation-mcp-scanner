import type { AccountMode } from "../journal/types.js";
import {
  supabaseInsertAndSelectOne,
  supabaseSelect,
  supabaseUpdateAndSelectOne,
} from "../supabase/serverClient.js";
import type { StrategyVersionId } from "./strategyVersion.js";

export type DailyRiskSnapshotRecord = {
  id: string;
  account_mode: AccountMode;
  session_date: string;
  account_value_usd: string;
  realized_pl_usd: string;
  open_unrealized_pl_usd: string | null;
  entry_count: number;
  equity_peak_usd: string;
  risk_snapshot_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function isMissingRecoveryTable(error: unknown, table: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(table)
    && (
      message.includes("PGRST205")
      || message.toLowerCase().includes("schema cache")
      || message.toLowerCase().includes("could not find")
    );
}

export async function upsertDailyRiskSnapshot(params: {
  accountMode: AccountMode;
  sessionDate: string;
  accountValueUsd: number;
  realizedPlUsd: number;
  openUnrealizedPlUsd: number | null;
  entryCount: number;
  riskSnapshot?: Record<string, unknown> | null;
}): Promise<DailyRiskSnapshotRecord | null> {
  try {
    const existing = await supabaseSelect<DailyRiskSnapshotRecord>({
      table: "strategy_daily_risk_snapshots",
      select: "*",
      filters: [
        `account_mode=eq.${params.accountMode}`,
        `session_date=eq.${params.sessionDate}`,
      ],
      limit: 1,
    });
    const now = new Date().toISOString();
    const current = existing[0];
    if (current) {
      const priorPeak = Number(current.equity_peak_usd);
      return await supabaseUpdateAndSelectOne<DailyRiskSnapshotRecord>({
        table: "strategy_daily_risk_snapshots",
        filters: [`id=eq.${current.id}`],
        values: {
          realized_pl_usd: params.realizedPlUsd,
          open_unrealized_pl_usd: params.openUnrealizedPlUsd,
          entry_count: params.entryCount,
          equity_peak_usd: Math.max(
            Number.isFinite(priorPeak) ? priorPeak : params.accountValueUsd,
            params.accountValueUsd,
          ),
          risk_snapshot_json: params.riskSnapshot ?? current.risk_snapshot_json,
          updated_at: now,
        },
      });
    }
    return await supabaseInsertAndSelectOne<DailyRiskSnapshotRecord>({
      table: "strategy_daily_risk_snapshots",
      values: {
        account_mode: params.accountMode,
        session_date: params.sessionDate,
        account_value_usd: params.accountValueUsd,
        realized_pl_usd: params.realizedPlUsd,
        open_unrealized_pl_usd: params.openUnrealizedPlUsd,
        entry_count: params.entryCount,
        equity_peak_usd: params.accountValueUsd,
        risk_snapshot_json: params.riskSnapshot ?? {},
      },
    });
  } catch (error) {
    if (isMissingRecoveryTable(error, "strategy_daily_risk_snapshots")) {
      return null;
    }
    throw error;
  }
}

export async function readAccountEquityPeakUsd(
  accountMode: AccountMode,
  currentAccountValueUsd: number | null,
): Promise<number | null> {
  try {
    const rows = await supabaseSelect<Pick<DailyRiskSnapshotRecord, "equity_peak_usd">>({
      table: "strategy_daily_risk_snapshots",
      select: "equity_peak_usd",
      filters: [`account_mode=eq.${accountMode}`],
      order: ["equity_peak_usd.desc"],
      limit: 1,
    });
    const recordedPeak = Number(rows[0]?.equity_peak_usd);
    const knownValues = [
      Number.isFinite(recordedPeak) && recordedPeak > 0 ? recordedPeak : null,
      currentAccountValueUsd !== null
      && Number.isFinite(currentAccountValueUsd)
      && currentAccountValueUsd > 0
        ? currentAccountValueUsd
        : null,
    ].filter((value): value is number => value !== null);
    return knownValues.length > 0 ? Math.max(...knownValues) : null;
  } catch (error) {
    if (isMissingRecoveryTable(error, "strategy_daily_risk_snapshots")) {
      return currentAccountValueUsd;
    }
    throw error;
  }
}

export async function recordStrategyOrderAudit(params: {
  accountMode: AccountMode;
  strategyVersion: StrategyVersionId;
  journalTradeId?: string | null;
  symbol?: string | null;
  optionSymbol?: string | null;
  decisionKind: string;
  action: string;
  outcome?: string | null;
  ruleId: string;
  inputQuote?: Record<string, unknown> | null;
  riskSnapshot?: Record<string, unknown> | null;
  brokerState?: Record<string, unknown> | null;
  note: string;
}): Promise<void> {
  try {
    await supabaseInsertAndSelectOne({
      table: "strategy_order_audits",
      values: {
        account_mode: params.accountMode,
        strategy_version: params.strategyVersion,
        journal_trade_id: params.journalTradeId ?? null,
        symbol: params.symbol ?? null,
        option_symbol: params.optionSymbol ?? null,
        decision_kind: params.decisionKind,
        action: params.action,
        outcome: params.outcome ?? null,
        rule_id: params.ruleId,
        input_quote_json: params.inputQuote ?? null,
        risk_snapshot_json: params.riskSnapshot ?? null,
        broker_state_json: params.brokerState ?? null,
        note: params.note,
      },
    });
  } catch (error) {
    if (!isMissingRecoveryTable(error, "strategy_order_audits")) {
      console.warn(
        "strategy order audit write failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
