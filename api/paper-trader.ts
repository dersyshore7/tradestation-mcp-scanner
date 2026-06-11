import { getPaperTraderStatus, runPaperTraderCycle } from "../src/automation/paperTrader.js";
import { readAutomationLane, readPaperTraderApiSecrets, type AutomationLane } from "../src/automation/config.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

type PaperTraderRequestBody = {
  mode?: string;
  prompt?: string;
  dryRun?: boolean;
};

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

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseMode(req: VercelRequestLike, body?: PaperTraderRequestBody): AutomationLane {
  return readAutomationLane(firstQueryValue(req.query?.mode))
    ?? readAutomationLane(body?.mode)
    ?? "paper";
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (!isAuthorized(req as RequestWithHeaders)) {
    sendError(res, 401, "Unauthorized.");
    return;
  }

  if (req.method === "GET") {
    try {
      const status = await getPaperTraderStatus(parseMode(req));
      sendJson(res, 200, { status });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load paper trader status.";
      sendError(res, 500, message);
      return;
    }
  }

  if (req.method === "POST") {
    try {
      const body = (req.body ?? {}) as PaperTraderRequestBody;
      const mode = parseMode(req, body);
      const result = await runPaperTraderCycle({
        mode,
        ...(
          typeof body.prompt === "string" && body.prompt.trim().length > 0
            ? { prompt: body.prompt.trim() }
            : {}
        ),
        dryRun: body.dryRun === true,
        source: "api",
      });
      sendJson(res, 200, result);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Paper trader cycle failed.";
      sendError(res, 500, message);
      return;
    }
  }

  sendError(res, 404, "Use GET /api/paper-trader or POST /api/paper-trader");
}
