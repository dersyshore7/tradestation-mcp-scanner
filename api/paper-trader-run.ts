import { runPaperTraderCycle } from "../src/automation/paperTrader.js";
import { readPaperTraderConfig } from "../src/automation/config.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

type RequestWithHeaders = VercelRequestLike & {
  headers?: Record<string, string | undefined>;
  query?: Record<string, string | string[] | undefined>;
};

function isAuthorized(req: RequestWithHeaders): boolean {
  const config = readPaperTraderConfig();
  if (!config.apiSecret) {
    return true;
  }

  return req.headers?.authorization === `Bearer ${config.apiSecret}`;
}

function readDryRun(req: RequestWithHeaders): boolean {
  const raw = req.query?.dryRun;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "1" || value === "true";
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  const request = req as RequestWithHeaders;
  if (!isAuthorized(request)) {
    sendError(res, 401, "Unauthorized.");
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    sendError(res, 404, "Use GET /api/paper-trader-run");
    return;
  }

  try {
    const result = await runPaperTraderCycle({
      dryRun: readDryRun(request),
      source: "api",
    });
    sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paper trader run failed.";
    sendError(res, 500, message);
  }
}
