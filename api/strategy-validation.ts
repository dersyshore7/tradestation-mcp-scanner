import {
  changeStrategyLifecycle,
  getStrategyValidation,
  listStrategyVersions,
} from "../src/automation/strategyValidation.js";
import type { StrategyLifecycleStatus } from "../src/automation/strategyVersion.js";
import {
  sendError,
  sendJson,
  type VercelRequestLike,
  type VercelResponseLike,
} from "./journal/shared.js";

type StrategyLifecycleBody = {
  version?: unknown;
  status?: unknown;
};

const LIFECYCLE_STATUSES = new Set<StrategyLifecycleStatus>([
  "shadow",
  "promoted",
  "halted",
  "retired",
]);

function firstQueryValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export default async function handler(
  req: VercelRequestLike,
  res: VercelResponseLike,
): Promise<void> {

  try {
    if (req.method === "GET") {
      const version = firstQueryValue(req.query?.version)?.trim();
      if (version) {
        sendJson(res, 200, await getStrategyValidation(version));
      } else {
        const strategies = await listStrategyVersions();
        const results = await Promise.all(
          strategies.map((strategy) => getStrategyValidation(strategy.version)),
        );
        sendJson(res, 200, { strategies: results });
      }
      return;
    }

    if (req.method === "POST") {
      const body = (req.body ?? {}) as StrategyLifecycleBody;
      const version = typeof body.version === "string" ? body.version.trim() : "";
      const status = typeof body.status === "string"
        ? body.status.trim() as StrategyLifecycleStatus
        : null;
      if (!version || !status || !LIFECYCLE_STATUSES.has(status)) {
        sendError(res, 400, "version and a valid lifecycle status are required.");
        return;
      }
      sendJson(res, 200, await changeStrategyLifecycle({ version, status }));
      return;
    }

    sendError(res, 404, "Use GET or POST /api/strategy-validation");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Strategy validation failed.";
    sendError(res, message.includes("promotion blocked") ? 409 : 500, message);
  }
}
