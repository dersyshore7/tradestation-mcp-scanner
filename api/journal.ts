import { createJournalTrade, getJournalTradeById, listRecentJournalTrades } from "../src/journal/repository.js";
import { validateJournalTradeCreatePayload } from "../src/journal/validation.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method === "GET") {
    try {
      const trades = await listRecentJournalTrades();
      sendJson(res, 200, { trades });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch journal trades.";
      sendError(res, 500, message);
      return;
    }
  }

  if (req.method === "POST") {
    try {
      const payload = validateJournalTradeCreatePayload(req.body);
      const created = await createJournalTrade(payload);
      const hydratedTrade = await getJournalTradeById(created.id);
      sendJson(res, 201, { trade: hydratedTrade ?? created });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid journal payload.";
      const status = message.toLowerCase().includes("must") || message.toLowerCase().includes("required") ? 400 : 500;
      sendError(res, status, message);
      return;
    }
  }

  sendError(res, 404, "Use GET /api/journal or POST /api/journal");
}
