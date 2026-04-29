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
  raw_result_json: Record<string, unknown>;
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
        raw_result_json: input.rawResult,
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
  limit = 500,
): Promise<PaperTraderRunHistoryResult> {
  try {
    const runs = await supabaseSelect<PaperTraderRunRecord>({
      table: "paper_trader_runs",
      select: "*",
      order: ["created_at.desc"],
      limit,
    });

    return {
      runs,
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
