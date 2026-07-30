import {
  supabaseInsertAndSelectOne,
  supabaseSelect,
} from "../supabase/serverClient.js";
import type { AccountMode } from "../journal/types.js";
import {
  LEGACY_PAPER_AUTOMATION_KEY,
  paperAutomationColumnFilter,
  type PaperAutomationKey,
} from "./paperAutomationBots.js";
import {
  LEGACY_STRATEGY_VERSION,
  type StrategyVersionId,
} from "./strategyVersion.js";

export type PaperTraderRunRecord = {
  id: string;
  created_at: string;
  mode: AccountMode;
  paper_automation_key?: PaperAutomationKey;
  strategy_version?: StrategyVersionId;
  dry_run: boolean;
  outcome: string;
  symbol: string | null;
  reason: string | null;
  raw_result_json: Record<string, unknown> | null;
};

export type PaperTraderRunCreateInput = {
  mode: AccountMode;
  paperAutomationKey?: PaperAutomationKey;
  strategyVersion?: StrategyVersionId;
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
  const config = asRecord(rawResult.config);
  const reconciliation = asRecord(rawResult.reconciliation);
  const closedExitReconciliation = asRecord(rawResult.closedExitReconciliation);
  const entryOrderManagement = asRecord(rawResult.entryOrderManagement);
  const management = asRecord(rawResult.management);
  const entry = asRecord(rawResult.entry);

  return {
    mode: rawResult.mode ?? "paper",
    paperAutomationKey: rawResult.paperAutomationKey ?? LEGACY_PAPER_AUTOMATION_KEY,
    timestamp: rawResult.timestamp ?? null,
    dryRun: rawResult.dryRun ?? null,
    dryRunReason: rawResult.dryRunReason ?? null,
    config: config
      ? {
          strategyVersion: config.strategyVersion ?? LEGACY_STRATEGY_VERSION,
          managementStyle: config.managementStyle ?? null,
          riskLimits: config.riskLimits ?? null,
          allowEntryOrders: config.allowEntryOrders ?? null,
          allowExitOrders: config.allowExitOrders ?? null,
          entryOrderManagementEnabled: config.entryOrderManagementEnabled ?? null,
        }
      : null,
    guards: rawResult.guards ?? null,
    reconciliation: reconciliation
      ? {
          inspected: reconciliation.inspected ?? null,
          updated: reconciliation.updated ?? null,
          staleArchived: reconciliation.staleArchived ?? null,
          adoptedPositions: reconciliation.adoptedPositions ?? null,
          updates: Array.isArray(reconciliation.updates)
            ? reconciliation.updates.slice(0, 20)
            : [],
          skipped: Array.isArray(reconciliation.skipped)
            ? reconciliation.skipped.slice(0, 20)
            : [],
        }
      : null,
    closedExitReconciliation: closedExitReconciliation
      ? {
          inspected: closedExitReconciliation.inspected ?? null,
          repaired: closedExitReconciliation.repaired ?? null,
          skipped: closedExitReconciliation.skipped ?? null,
          brokerConfirmedRealizedPlUsd: closedExitReconciliation.brokerConfirmedRealizedPlUsd ?? null,
          journalRealizedPlUsdBefore: closedExitReconciliation.journalRealizedPlUsdBefore ?? null,
          journalRealizedPlUsdAfter: closedExitReconciliation.journalRealizedPlUsdAfter ?? null,
          realizedPlDeltaUsd: closedExitReconciliation.realizedPlDeltaUsd ?? null,
          updates: Array.isArray(closedExitReconciliation.updates)
            ? closedExitReconciliation.updates.slice(0, 20)
            : [],
          skippedDetails: Array.isArray(closedExitReconciliation.skippedDetails)
            ? closedExitReconciliation.skippedDetails.slice(0, 20)
            : [],
          warnings: Array.isArray(closedExitReconciliation.warnings)
            ? closedExitReconciliation.warnings.slice(0, 20)
            : [],
        }
      : null,
    liveDailyAudit: rawResult.liveDailyAudit ?? null,
    entryOrderManagement: entryOrderManagement
      ? {
          enabled: entryOrderManagement.enabled ?? null,
          inspected: entryOrderManagement.inspected ?? null,
          updated: entryOrderManagement.updated ?? null,
          replaced: entryOrderManagement.replaced ?? null,
          canceled: entryOrderManagement.canceled ?? null,
          recommended: entryOrderManagement.recommended ?? null,
          updates: Array.isArray(entryOrderManagement.updates)
            ? entryOrderManagement.updates.slice(0, 20)
            : [],
          skipped: Array.isArray(entryOrderManagement.skipped)
            ? entryOrderManagement.skipped.slice(0, 20)
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
          scanSummary: entry.scanSummary ?? null,
          automatedScanState: entry.automatedScanState ?? null,
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
        paper_automation_key: input.paperAutomationKey ?? LEGACY_PAPER_AUTOMATION_KEY,
        strategy_version: input.strategyVersion ?? LEGACY_STRATEGY_VERSION,
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
  options: {
    includeRawResult?: boolean;
    mode?: AccountMode;
    paperAutomationKey?: PaperAutomationKey;
    strategyVersion?: StrategyVersionId;
  } = {},
): Promise<PaperTraderRunHistoryResult> {
  try {
    const runs = await supabaseSelect<PaperTraderRunRecord>({
      table: "paper_trader_runs",
      select: options.includeRawResult
        ? "id,created_at,mode,paper_automation_key,strategy_version,dry_run,outcome,symbol,reason,raw_result_json"
        : "id,created_at,mode,paper_automation_key,strategy_version,dry_run,outcome,symbol,reason",
      filters: [
        ...(options.mode ? [`mode=eq.${options.mode}`] : []),
        paperAutomationColumnFilter(options.paperAutomationKey ?? LEGACY_PAPER_AUTOMATION_KEY),
        ...(options.strategyVersion
          ? [`strategy_version=eq.${encodeURIComponent(options.strategyVersion)}`]
          : []),
      ],
      order: ["created_at.desc"],
      limit,
    });

    return {
      runs: options.includeRawResult
        ? runs
        : runs.map((run) => ({ ...run, raw_result_json: null })),
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

export async function loadLatestPaperTraderRunWithRaw(
  options: { dryRun: boolean; paperAutomationKey?: PaperAutomationKey },
): Promise<PaperTraderRunRecord | null> {
  const runs = await supabaseSelect<PaperTraderRunRecord>({
    table: "paper_trader_runs",
    select: "id,created_at,mode,paper_automation_key,dry_run,outcome,symbol,reason,raw_result_json",
    filters: [
      `dry_run=eq.${options.dryRun}`,
      paperAutomationColumnFilter(options.paperAutomationKey ?? LEGACY_PAPER_AUTOMATION_KEY),
    ],
    order: ["created_at.desc"],
    limit: 1,
  });

  return runs[0] ?? null;
}
