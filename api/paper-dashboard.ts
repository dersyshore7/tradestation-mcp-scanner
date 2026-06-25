import { getPaperTraderSizingSnapshot } from "../src/automation/paperTrader.js";
import { buildEmptyPaperDashboard, getPaperDashboard } from "../src/journal/paperDashboard.js";
import { readAutomationLane, type AutomationLane } from "../src/automation/config.js";
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

function parseMode(value: string | string[] | undefined): AutomationLane {
  return readAutomationLane(firstQueryValue(value)) ?? "paper";
}

function formatWarning(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    message.includes("522")
    || message.includes("504")
    || normalized.includes("request timed out")
    || normalized.includes("connection timed out")
    || normalized.includes("upstream request timeout")
  ) {
    return `${label}: Supabase timed out before returning data.`;
  }
  return `${label}: ${message}`;
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "GET") {
    sendError(res, 404, "Use GET /api/paper-dashboard");
    return;
  }

  const limit = parseLimit(req.query?.limit);
  const mode = parseMode(req.query?.mode);
  const [dashboardResult, simAccountResult] = await Promise.allSettled([
    getPaperDashboard(limit, mode),
    getPaperTraderSizingSnapshot(mode),
  ]);

  const dashboard = dashboardResult.status === "fulfilled"
    ? dashboardResult.value
    : buildEmptyPaperDashboard([formatWarning(`${mode === "live" ? "Live" : "Paper"} dashboard data unavailable`, dashboardResult.reason)], mode);
  const accountLabel = mode === "live" ? "LIVE account" : "SIM account";
  const simAccount = simAccountResult.status === "fulfilled"
    ? simAccountResult.value
    : {
        accountValueUsd: null,
        beginningOfDayAccountValueUsd: null,
        cashBalanceUsd: null,
        unrealizedPlUsd: null,
        equitiesBuyingPowerUsd: null,
        optionsBuyingPowerUsd: null,
        dayTradeExcessUsd: null,
        maxPositionCostUsd: null,
        openPositionCount: null,
        openContractCount: null,
        openPositionCostUsd: null,
        openPositionMarketValueUsd: null,
        positions: [],
        error: formatWarning(`${accountLabel} snapshot unavailable`, simAccountResult.reason),
      };

  sendJson(res, 200, {
    dashboard: {
      ...dashboard,
      account_snapshot: simAccount,
      sim_account: simAccount,
    },
  });
}
