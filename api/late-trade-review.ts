import { reviewLateTrade, validateLateTradeReviewPayload } from "../src/review/lateTradeReview.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

function isValidationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("required")
    || normalized.includes("must")
    || normalized.includes("valid")
    || normalized.includes("on/after");
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "POST") {
    sendError(res, 404, "Use POST /api/late-trade-review");
    return;
  }

  try {
    const input = validateLateTradeReviewPayload(req.body);
    const result = await reviewLateTrade(input);
    sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to review late trade.";
    sendError(res, isValidationError(message) ? 400 : 500, message);
  }
}
