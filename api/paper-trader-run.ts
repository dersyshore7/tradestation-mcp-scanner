import { runPaperTraderCycle } from "../src/automation/paperTrader.js";
import { readPaperTraderApiSecrets } from "../src/automation/config.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

type RequestWithHeaders = VercelRequestLike & {
  headers?: Record<string, string | undefined>;
  query?: Record<string, string | string[] | undefined>;
};

function isAuthorized(req: RequestWithHeaders): boolean {
  const secrets = readPaperTraderApiSecrets();
  if (secrets.length === 0) {
    return true;
  }

  return secrets.some((secret) => req.headers?.authorization === `Bearer ${secret}`);
}

function readBooleanQuery(req: RequestWithHeaders, name: string): boolean {
  const raw = req.query?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "1" || value === "true";
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  const request = req as RequestWithHeaders;
  if (!isAuthorized(request)) {
    console.warn("paper-trader-run unauthorized", {
      method: req.method,
      hasAuthorizationHeader: Boolean(request.headers?.authorization),
    });
    sendError(res, 401, "Unauthorized.");
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    sendError(res, 404, "Use GET /api/paper-trader-run");
    return;
  }

  try {
    const startedAt = Date.now();
    const options = {
      dryRun: readBooleanQuery(request, "dryRun"),
      reconcileOnly: readBooleanQuery(request, "reconcileOnly"),
      reconcileOrders: readBooleanQuery(request, "reconcileOrders"),
      skipNewEntry:
        readBooleanQuery(request, "skipNewEntry")
        || readBooleanQuery(request, "manageOnly"),
      includeHistory: false,
      source: "api" as const,
    };
    console.info("paper-trader-run started", {
      method: req.method,
      dryRun: options.dryRun,
      reconcileOnly: options.reconcileOnly,
      reconcileOrders: options.reconcileOrders,
      skipNewEntry: options.skipNewEntry,
    });
    const result = await runPaperTraderCycle({
      ...options,
    });
    console.info("paper-trader-run completed", {
      durationMs: Date.now() - startedAt,
      dryRun: result.dryRun,
      openPaperTrades: result.guards.openPaperTrades,
      managementInspected: result.management.inspected,
      exitsTriggered: result.management.exitsTriggered.length,
      entryOutcome: result.entry.outcome,
      entrySymbol: result.entry.symbol,
    });
    sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paper trader run failed.";
    console.error("paper-trader-run failed", { message });
    sendError(res, 500, message);
  }
}
