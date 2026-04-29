import { markTradeRecommendationJournaled } from "../../src/recommendations/repository.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "../journal/shared.js";

function readId(req: VercelRequestLike): string | null {
  const raw = req.query?.id;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  if (Array.isArray(raw) && raw[0] && raw[0].trim().length > 0) {
    return raw[0].trim();
  }
  return null;
}

function readJournalTradeId(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Payload must be a JSON object.");
  }

  const value = (body as Record<string, unknown>).journal_trade_id;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("journal_trade_id is required.");
  }

  return value.trim();
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  const id = readId(req);
  if (!id) {
    sendError(res, 400, "Missing trade recommendation id.");
    return;
  }

  if (req.method !== "PATCH") {
    sendError(res, 404, "Use PATCH /api/recommendations/:id");
    return;
  }

  try {
    const journalTradeId = readJournalTradeId(req.body);
    const recommendation = await markTradeRecommendationJournaled(id, journalTradeId);
    sendJson(res, 200, { recommendation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update trade recommendation.";
    const status = message.toLowerCase().includes("required") || message.toLowerCase().includes("object") ? 400 : 500;
    sendError(res, status, message);
  }
}
