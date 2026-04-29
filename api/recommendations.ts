import { listRecentTradeRecommendations } from "../src/recommendations/repository.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "GET") {
    sendError(res, 404, "Use GET /api/recommendations");
    return;
  }

  try {
    const recommendations = await listRecentTradeRecommendations();
    sendJson(res, 200, { recommendations });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch trade recommendations.";
    sendError(res, 500, message);
  }
}
