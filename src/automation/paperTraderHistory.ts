import {
  supabaseInsertAndSelectOne,
  supabaseSelect,
} from "../supabase/serverClient.js";

export type PaperTraderRunRecord = {
  id: string;
  created_at: string;
  mode: "paper";
  dry_run: boolean;
  outcome: string;
  symbol: string | null;
  reason: string | null;
  raw_result_json: Record<string, unknown> | null;
};

export type PaperTraderRunCreateInput = {
  mode: "paper";
  dryRun: boolean;
  outcome: string;
  symbol: string | null;
  reason: string | null;
  rawResult: Record<string, unknown>;
};

export type PaperTraderRunHistoryResult = {
  runs: PaperTraderRunRecord[];
  migrationRequired: boolean;
  migrationMessage: string | null;
};

function isPaperTraderRunsTableMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("PGRST205")
    && message.includes("paper_trader_runs")
  ) || (
    message.toLowerCase().includes("could not find the table")
    && message.includes("paper_trader_runs")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function buildCompactRunResult(rawResult: Record<string, unknown>): Record<string, unknown> {
  const reconciliation = asRecord(rawResult.reconciliation);
  const management = asRecord(rawResult.management);
  const entry = asRecord(rawResult.entry);

  return {
    mode: rawResult.mode ?? "paper",
    timestamp: rawResult.timestamp ?? null,
    dryRun: rawResult.dryRun ?? null,
    dryRunReason: rawResult.dryRunReason ?? null,
    guards: rawResult.guards ?? null,
    reconciliation: reconciliation
      ? {
          inspected: reconciliation.inspected ?? null,
          updated: reconciliation.updated ?? null,
          updates: Array.isArray(reconciliation.updates)
            ? reconciliation.updates.slice(0, 20)
            : [],
          skipped: Array.isArray(reconciliation.skipped)
            ? reconciliation.skipped.slice(0, 20)
            : [],
        }
      : null,
    management: management
      ? {
          inspected: management.inspected ?? null,
          updates: Array.isArray(management.updates)
            ? management.updates.slice(0, 20)
            : [],
          exitsTriggered: Array.isArray(management.exitsTriggered)
            ? management.exitsTriggered.slice(0, 20)
            : [],
          skipped: Array.isArray(management.skipped)
            ? management.skipped.slice(0, 20)
            : [],
        }
      : null,
    entry: entry
      ? {
          attempted: entry.attempted ?? null,
          outcome: entry.outcome ?? null,
          symbol: entry.symbol ?? null,
          reason: entry.reason ?? null,
          orderId: entry.orderId ?? null,
          journalTradeId: entry.journalTradeId ?? null,
        }
      : null,
  };
}

export async function recordPaperTraderRun(
  input: PaperTraderRunCreateInput,
): Promise<PaperTraderRunRecord | null> {
  try {
    return await supabaseInsertAndSelectOne<PaperTraderRunRecord>({
      table: "paper_trader_runs",
      values: {
        mode: input.mode,
        dry_run: input.dryRun,
        outcome: input.outcome,
        symbol: input.symbol,
        reason: input.reason,
        raw_result_json: buildCompactRunResult(input.rawResult),
      },
    });
  } catch (error) {
    if (isPaperTraderRunsTableMissing(error)) {
      return null;
    }
    throw error;
  }
}

export async function listRecentPaperTraderRuns(
  limit = 50,
): Promise<PaperTraderRunHistoryResult> {
  try {
    const runs = await supabaseSelect<PaperTraderRunRecord>({
      table: "paper_trader_runs",
      select: "id,created_at,mode,dry_run,outcome,symbol,reason",
      order: ["created_at.desc"],
      limit,
    });

    return {
      runs: runs.map((run) => ({ ...run, raw_result_json: null })),
      migrationRequired: false,
      migrationMessage: null,
    };
  } catch (error) {
    if (!isPaperTraderRunsTableMissing(error)) {
      throw error;
    }

    return {
      runs: [],
      migrationRequired: true,
      migrationMessage:
        "Supabase is missing the paper_trader_runs table. Apply supabase/migrations/202604290001_paper_trader_runs.sql to show paper-trader cron/run history in the app.",
    };
  }
}
