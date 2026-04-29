import { closeJournalTrade, deleteJournalTrade, getJournalTradeById, updateJournalTrade } from "../../src/journal/repository.js";
import { validateJournalTradeClosePayload, validateJournalTradeUpdatePayload } from "../../src/journal/validation.js";
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
  const id = readId(req);
  if (!id) {
    sendError(res, 400, "Missing journal trade id.");
    return;
  }

  if (req.method === "GET") {
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
    return;
  }

  if (req.method === "PATCH") {
    try {
      const payload = validateJournalTradeClosePayload(req.body);
      const trade = await closeJournalTrade(id, payload);
      sendJson(res, 200, { trade });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to close journal trade.";
      const status = message.toLowerCase().includes("must") || message.toLowerCase().includes("required") ? 400 : 500;
      sendError(res, status, message);
    }
    return;
  }

  if (req.method === "PUT") {
    try {
      const payload = validateJournalTradeUpdatePayload(req.body);
      const trade = await updateJournalTrade(id, payload);
      sendJson(res, 200, { trade });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update journal trade.";
      const normalized = message.toLowerCase();
      const status = normalized.includes("not found")
        ? 404
        : normalized.includes("must")
          || normalized.includes("required")
          || normalized.includes("only closed")
          || normalized.includes("valid")
          || normalized.includes("integer")
          || normalized.includes("paper or live")
          || normalized.includes("on/before")
          || normalized.includes("yyyy-mm-dd")
          ? 400
          : 500;
      sendError(res, status, message);
    }
    return;
  }

  if (req.method === "DELETE") {
    try {
      await deleteJournalTrade(id);
      sendJson(res, 200, { deleted: true, id });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete journal trade.";
      sendError(res, message.toLowerCase().includes("not found") ? 404 : 500, message);
    }
    return;
  }

  sendError(res, 404, "Use GET, PATCH, PUT, or DELETE /api/journal/:id");
}
