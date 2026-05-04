import { getJournalInsights } from "../../src/journal/repository.js";
import { readPaperTraderApiSecrets } from "../../src/automation/config.js";
import { getPaperTraderSizingSnapshot } from "../../src/automation/paperTrader.js";
import { ACCOUNT_MODES, type AccountMode } from "../../src/journal/types.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./shared.js";

type RequestWithHeaders = VercelRequestLike & {
  headers?: Record<string, string | undefined>;
};

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseBooleanQuery(value: string | string[] | undefined): boolean {
  const normalized = firstQueryValue(value)?.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseLimitQuery(value: string | string[] | undefined, fallback: number): number {
  const parsed = Number(firstQueryValue(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(500, Math.max(10, Math.floor(parsed)));
}

function parseAccountModeQuery(value: string | string[] | undefined): AccountMode | undefined {
  const normalized = firstQueryValue(value)?.toLowerCase();
  return ACCOUNT_MODES.includes(normalized as AccountMode) ? normalized as AccountMode : undefined;
}

function isPaperTraderAuthorized(req: RequestWithHeaders): boolean {
  const secrets = readPaperTraderApiSecrets();
  if (secrets.length === 0) {
    return true;
  }

  return secrets.some((secret) => req.headers?.authorization === `Bearer ${secret}`);
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "GET") {
    sendError(res, 404, "Use GET /api/journal/insights");
    return;
  }

  try {
    const includeReasoning = parseBooleanQuery(req.query?.includeReasoning);
    const includeSimAccount = parseBooleanQuery(req.query?.includeSimAccount);
    const limit = parseLimitQuery(req.query?.limit, includeReasoning ? 75 : 500);
    const accountMode = parseAccountModeQuery(req.query?.accountMode);
    const insights = await getJournalInsights(limit, { includeReasoning, accountMode });
    const simAccount = includeSimAccount
      ? isPaperTraderAuthorized(req as RequestWithHeaders)
        ? await getPaperTraderSizingSnapshot()
        : {
            accountValueUsd: null,
            unrealizedPlUsd: null,
            equitiesBuyingPowerUsd: null,
            optionsBuyingPowerUsd: null,
            maxPositionCostUsd: null,
            error: "Unauthorized to load TradeStation SIM account snapshot.",
          }
      : null;
    sendJson(res, 200, { insights: { ...insights, sim_account: simAccount } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build journal insights.";
    sendError(res, 500, message);
  }
}
