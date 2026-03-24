import { getJournalTradeById } from "../../src/journal/repository.js";
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

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "GET") {
    sendError(res, 404, "Use GET /api/journal/:id");
    return;
  }

  const id = readId(req);
  if (!id) {
    sendError(res, 400, "Missing journal trade id.");
    return;
  }

  try {
    const trade = await getJournalTradeById(id);
    if (!trade) {
      sendError(res, 404, "Journal trade not found.");
      return;
    }
    sendJson(res, 200, { trade });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch journal trade.";
    sendError(res, 500, message);
  }
}
