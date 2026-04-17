import { getJournalInsights } from "../../src/journal/repository.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./shared.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "GET") {
    sendError(res, 404, "Use GET /api/journal/insights");
    return;
  }

  try {
    const insights = await getJournalInsights();
    sendJson(res, 200, { insights });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build journal insights.";
    sendError(res, 500, message);
  }
}
