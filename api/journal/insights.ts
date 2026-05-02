import { getJournalInsights } from "../../src/journal/repository.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./shared.js";

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseBooleanQuery(value: string | string[] | undefined): boolean {
  const normalized = firstQueryValue(value)?.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseLimitQuery(value: string | string[] | undefined, fallback: number): number {
  const parsed = Number(firstQueryValue(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(500, Math.max(10, Math.floor(parsed)));
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "GET") {
    sendError(res, 404, "Use GET /api/journal/insights");
    return;
  }

  try {
    const includeReasoning = parseBooleanQuery(req.query?.includeReasoning);
    const limit = parseLimitQuery(req.query?.limit, includeReasoning ? 75 : 500);
    const insights = await getJournalInsights(limit, { includeReasoning });
    sendJson(res, 200, { insights });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build journal insights.";
    sendError(res, 500, message);
  }
}
