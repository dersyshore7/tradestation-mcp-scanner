import { getJournalInsights } from "../../src/journal/repository.js";
import { getPaperTraderSizingSnapshot } from "../../src/automation/paperTrader.js";
import { ACCOUNT_MODES, type AccountMode } from "../../src/journal/types.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./shared.js";

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
    const insights = await getJournalInsights(limit, {
      includeReasoning,
      ...(accountMode ? { accountMode } : {}),
    });
    const simAccount = includeSimAccount
      ? await getPaperTraderSizingSnapshot(accountMode ?? "paper").catch((error) => ({
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
          error: error instanceof Error ? error.message : "TradeStation account snapshot unavailable.",
        }))
      : null;
    sendJson(res, 200, { insights: { ...insights, sim_account: simAccount } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build journal insights.";
    sendError(res, 500, message);
  }
}
