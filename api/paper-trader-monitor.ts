import { runPaperTraderCycle } from "../src/automation/paperTrader.js";
import { readPaperTraderApiSecrets } from "../src/automation/config.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

type RequestWithHeaders = VercelRequestLike & {
  headers?: Record<string, string | undefined>;
};

function isAuthorized(req: RequestWithHeaders): boolean {
  const secrets = readPaperTraderApiSecrets();
  if (secrets.length === 0) {
    return true;
  }

  return secrets.some((secret) => req.headers?.authorization === `Bearer ${secret}`);
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  const request = req as RequestWithHeaders;
  if (!isAuthorized(request)) {
    sendError(res, 401, "Unauthorized.");
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    sendError(res, 404, "Use GET /api/paper-trader-monitor");
    return;
  }

  try {
    const result = await runPaperTraderCycle({
      dryRun: true,
      reconcileOnly: true,
      reconcileOrders: true,
      skipNewEntry: true,
      source: "api",
    });
    sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paper trader monitor failed.";
    sendError(res, 500, message);
  }
}
