import { getPaperTraderStatus, runPaperTraderCycle } from "../src/automation/paperTrader.js";
import { readAutomationLane, type AutomationLane } from "../src/automation/config.js";
import {
  readVirtualPaperAutomationKey,
  type VirtualPaperAutomationKey,
} from "../src/automation/paperAutomationBots.js";
import {
  getVirtualPaperAutomationStatus,
  runVirtualPaperAutomationCycle,
} from "../src/automation/virtualPaperTrader.js";
import { requireApiBearerAuth } from "./auth.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

type PaperTraderRequestBody = {
  mode?: string;
  automation?: string;
  prompt?: string;
  dryRun?: boolean;
  reconcileOnly?: boolean;
  reconcileOrders?: boolean;
  skipNewEntry?: boolean;
};

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseMode(req: VercelRequestLike, body?: PaperTraderRequestBody): AutomationLane {
  return readAutomationLane(firstQueryValue(req.query?.mode))
    ?? readAutomationLane(body?.mode)
    ?? "paper";
}

function parseVirtualAutomation(req: VercelRequestLike, body?: PaperTraderRequestBody): VirtualPaperAutomationKey | null {
  return readVirtualPaperAutomationKey(firstQueryValue(req.query?.automation))
    ?? readVirtualPaperAutomationKey(body?.automation);
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (!requireApiBearerAuth(req, res)) {
    return;
  }
  if (req.method === "GET") {
    try {
      const mode = parseMode(req);
      const automation = parseVirtualAutomation(req);
      if (mode === "live" && automation) {
        sendError(res, 400, "Virtual paper automations are paper-only and cannot run on the live lane.");
        return;
      }
      const status = automation
        ? await getVirtualPaperAutomationStatus(automation)
        : await getPaperTraderStatus(mode);
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
      const automation = parseVirtualAutomation(req, body);
      if (mode === "live" && automation) {
        sendError(res, 400, "Virtual paper automations are paper-only and cannot run on the live lane.");
        return;
      }
      if (
        mode === "live"
        && typeof body.prompt === "string"
        && body.prompt.trim().length > 0
      ) {
        sendError(
          res,
          400,
          "LIVE prompt overrides are disabled; LIVE always uses support_resistance_v1.",
        );
        return;
      }
      const result = automation
        ? await runVirtualPaperAutomationCycle({
            automationKey: automation,
            dryRun: body.dryRun === true,
          })
        : await runPaperTraderCycle({
            mode,
            ...(
              typeof body.prompt === "string" && body.prompt.trim().length > 0
                ? { prompt: body.prompt.trim() }
                : {}
            ),
            dryRun: body.dryRun === true,
            reconcileOnly: body.reconcileOnly === true,
            reconcileOrders: body.reconcileOrders === true,
            skipNewEntry: body.skipNewEntry === true,
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
