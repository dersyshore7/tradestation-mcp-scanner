import { listRecentPaperTraderRuns } from "../src/automation/paperTraderHistory.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

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

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "GET") {
    sendError(res, 404, "Use GET /api/paper-activity");
    return;
  }

  try {
    const result = await listRecentPaperTraderRuns(parseLimit(req.query?.limit), {
      includeRawResult: true,
    });
    sendJson(res, 200, {
      activity: {
        runs: result.runs,
        migrationRequired: result.migrationRequired,
        dataWarnings: result.migrationMessage ? [result.migrationMessage] : [],
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
