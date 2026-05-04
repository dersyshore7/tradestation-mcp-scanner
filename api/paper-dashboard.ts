import { getPaperTraderSizingSnapshot } from "../src/automation/paperTrader.js";
import { buildEmptyPaperDashboard, getPaperDashboard } from "../src/journal/paperDashboard.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseLimit(value: string | string[] | undefined): number {
  const parsed = Number(firstQueryValue(value));
  if (!Number.isFinite(parsed)) {
    return 300;
  }
  return Math.min(500, Math.max(50, Math.floor(parsed)));
}

function formatWarning(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${label}: ${message}`;
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "GET") {
    sendError(res, 404, "Use GET /api/paper-dashboard");
    return;
  }

  const limit = parseLimit(req.query?.limit);
  const [dashboardResult, simAccountResult] = await Promise.allSettled([
    getPaperDashboard(limit),
    getPaperTraderSizingSnapshot(),
  ]);

  const dashboard = dashboardResult.status === "fulfilled"
    ? dashboardResult.value
    : buildEmptyPaperDashboard([formatWarning("Paper dashboard data unavailable", dashboardResult.reason)]);
  const simAccount = simAccountResult.status === "fulfilled"
    ? simAccountResult.value
    : {
        accountValueUsd: null,
        unrealizedPlUsd: null,
        equitiesBuyingPowerUsd: null,
        optionsBuyingPowerUsd: null,
        maxPositionCostUsd: null,
        error: formatWarning("SIM account snapshot unavailable", simAccountResult.reason),
      };

  sendJson(res, 200, {
    dashboard: {
      ...dashboard,
      sim_account: simAccount,
    },
  });
}
