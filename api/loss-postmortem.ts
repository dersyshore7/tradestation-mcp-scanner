import {
  buildLossPostMortemFromJournalTrade,
  runLossPostMortemAiReview,
} from "../src/journal/lossPostMortem.js";
import { getJournalTradeById } from "../src/journal/repository.js";
import { readPaperTraderApiSecrets } from "../src/automation/config.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

type RequestWithHeaders = VercelRequestLike & {
  headers?: Record<string, string | undefined>;
};

type LossPostMortemRequestBody = {
  tradeId?: unknown;
  id?: unknown;
};

function isAuthorized(req: RequestWithHeaders): boolean {
  const secrets = readPaperTraderApiSecrets();
  if (secrets.length === 0) {
    return true;
  }

  return secrets.some((secret) => req.headers?.authorization === `Bearer ${secret}`);
}

function readBody(body: unknown): LossPostMortemRequestBody {
  if (typeof body === "string" && body.trim().length > 0) {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as LossPostMortemRequestBody
      : {};
  }
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as LossPostMortemRequestBody
    : {};
}

function readTradeId(body: LossPostMortemRequestBody): string | null {
  const value = typeof body.tradeId === "string" ? body.tradeId : body.id;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  const request = req as RequestWithHeaders;
  if (!isAuthorized(request)) {
    sendError(res, 401, "Unauthorized.");
    return;
  }

  if (req.method !== "POST") {
    sendError(res, 404, "Use POST /api/loss-postmortem");
    return;
  }

  try {
    const tradeId = readTradeId(readBody(req.body));
    if (!tradeId) {
      sendError(res, 400, "Missing tradeId.");
      return;
    }

    const trade = await getJournalTradeById(tradeId);
    if (!trade) {
      sendError(res, 404, "Journal trade not found.");
      return;
    }
    if (trade.status !== "closed") {
      sendError(res, 400, "Only closed trades can be post-mortemed.");
      return;
    }

    const realizedPl = asNumber(trade.review?.realized_pl_usd);
    if (realizedPl === null || realizedPl >= 0) {
      sendError(res, 400, "Only realized losing trades can be post-mortemed.");
      return;
    }

    const postMortem = buildLossPostMortemFromJournalTrade(trade);
    const aiReview = await runLossPostMortemAiReview(trade, postMortem);

    sendJson(res, 200, {
      tradeId: trade.id,
      post_mortem: postMortem,
      ai_review: aiReview,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build loss post-mortem.";
    sendError(res, 500, message);
  }
}
