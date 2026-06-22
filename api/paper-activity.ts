import { listRecentPaperTraderRuns } from "../src/automation/paperTraderHistory.js";
import {
  listRecentPaperEntryCandidates,
  type PaperEntryCandidateRecord,
} from "../src/automation/entryCandidateHistory.js";
import { readAutomationLane, type AutomationLane } from "../src/automation/config.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

type CandidateActivity = Pick<
  PaperEntryCandidateRecord,
  "created_at" | "scan_run_id" | "symbol" | "decision" | "decision_reason"
>;

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseLimit(value: string | string[] | undefined): number {
  const parsed = Number(firstQueryValue(value));
  if (!Number.isFinite(parsed)) {
    return 25;
  }
  return Math.min(50, Math.max(5, Math.floor(parsed)));
}

function parseMode(value: string | string[] | undefined): AutomationLane {
  return readAutomationLane(firstQueryValue(value)) ?? "paper";
}

function formatWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    message.includes("522")
    || message.includes("504")
    || normalized.includes("request timed out")
    || normalized.includes("connection timed out")
    || normalized.includes("upstream request timeout")
  ) {
    return "Automation activity unavailable: Supabase timed out before returning run history.";
  }
  return `Automation activity unavailable: ${message}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readRunScanRunId(run: { raw_result_json: Record<string, unknown> | null }): string | null {
  const raw = asRecord(run.raw_result_json);
  const entry = asRecord(raw?.entry);
  const state = asRecord(entry?.automatedScanState);
  return typeof state?.scanRunId === "string" ? state.scanRunId : null;
}

async function loadCandidateActivity(scanRunIds: Set<string>): Promise<{
  candidates: CandidateActivity[];
  warning: string | null;
}> {
  if (scanRunIds.size === 0) {
    return { candidates: [], warning: null };
  }

  try {
    const result = await listRecentPaperEntryCandidates(75);
    const candidates = result.candidates
      .filter((candidate) =>
        typeof candidate.scan_run_id === "string" && scanRunIds.has(candidate.scan_run_id)
      )
      .slice(0, 10)
      .map((candidate) => ({
        created_at: candidate.created_at,
        scan_run_id: candidate.scan_run_id,
        symbol: candidate.symbol,
        decision: candidate.decision,
        decision_reason: candidate.decision_reason,
      }));

    return {
      candidates,
      warning: result.migrationMessage,
    };
  } catch (error) {
    return {
      candidates: [],
      warning: formatWarning(error),
    };
  }
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "GET") {
    sendError(res, 404, "Use GET /api/paper-activity");
    return;
  }

  try {
    const mode = parseMode(req.query?.mode);
    const result = await listRecentPaperTraderRuns(parseLimit(req.query?.limit), {
      includeRawResult: true,
      mode,
    });
    const scanRunIds = new Set(
      result.runs
        .map(readRunScanRunId)
        .filter((scanRunId): scanRunId is string => scanRunId !== null),
    );
    const candidateActivity = await loadCandidateActivity(scanRunIds);
    const dataWarnings = [
      result.migrationMessage,
      candidateActivity.warning,
    ].filter((warning): warning is string => Boolean(warning));
    sendJson(res, 200, {
      activity: {
        runs: result.runs,
        candidateActivity: candidateActivity.candidates,
        migrationRequired: result.migrationRequired,
        dataWarnings,
      },
    });
  } catch (error) {
    sendJson(res, 200, {
      activity: {
        runs: [],
        migrationRequired: false,
        dataWarnings: [formatWarning(error)],
      },
    });
  }
}
