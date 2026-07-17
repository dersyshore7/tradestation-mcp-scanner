import assert from "node:assert/strict";
import test from "node:test";
import dashboardHandler from "./paper-dashboard.js";
import activityHandler from "./paper-activity.js";
import paperTraderRunHandler from "./paper-trader-run.js";
import journalHandler from "./journal.js";
import journalItemHandler from "./journal/[id].js";
import recommendationItemHandler from "./recommendations/[id].js";
import { isApiBearerAuthorized, requireApiBearerAuth } from "./auth.js";
import type { VercelRequestLike, VercelResponseLike } from "./journal/shared.js";

const AUTH_ENV_KEYS = ["AUTO_TRADER_API_SECRET", "CRON_SECRET"] as const;

type TestResponse = VercelResponseLike & {
  statusCode: number;
  body: unknown;
};

function createResponse(): TestResponse {
  return {
    statusCode: 0,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
    },
  };
}

async function withAuthEnv<T>(
  values: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>>,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of AUTH_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const key of AUTH_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("API bearer auth fails closed when no secret is configured", async () => {
  await withAuthEnv({}, () => {
    const res = createResponse();
    const ok = requireApiBearerAuth({ method: "GET" }, res);

    assert.equal(ok, false);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, {
      error: true,
      message: "API bearer auth is not configured.",
    });
  });
});

test("API bearer auth accepts either configured secret", async () => {
  await withAuthEnv({
    AUTO_TRADER_API_SECRET: "auto-secret",
    CRON_SECRET: "cron-secret",
  }, () => {
    assert.equal(isApiBearerAuthorized({
      method: "GET",
      headers: { authorization: "Bearer auto-secret" },
    } as VercelRequestLike), true);
    assert.equal(isApiBearerAuthorized({
      method: "GET",
      headers: { authorization: "Bearer cron-secret" },
    } as VercelRequestLike), true);
    assert.equal(isApiBearerAuthorized({
      method: "GET",
      headers: { authorization: "Bearer wrong-secret" },
    } as VercelRequestLike), false);
  });
});

test("sensitive service-role-backed routes reject missing bearer auth", async () => {
  await withAuthEnv({ AUTO_TRADER_API_SECRET: "test-secret" }, async () => {
    const cases: {
      label: string;
      handler: (req: VercelRequestLike, res: VercelResponseLike) => Promise<void>;
      req: VercelRequestLike;
    }[] = [
      {
        label: "paper dashboard read",
        handler: dashboardHandler,
        req: { method: "GET", query: { mode: "paper" } },
      },
      {
        label: "paper activity read",
        handler: activityHandler,
        req: { method: "GET", query: { mode: "paper" } },
      },
      {
        label: "automation run",
        handler: paperTraderRunHandler,
        req: { method: "GET", query: { mode: "paper" } },
      },
      {
        label: "journal write",
        handler: journalHandler,
        req: { method: "POST", body: {} },
      },
      {
        label: "journal update",
        handler: journalItemHandler,
        req: { method: "PUT", query: { id: "trade-id" }, body: {} },
      },
      {
        label: "journal delete",
        handler: journalItemHandler,
        req: { method: "DELETE", query: { id: "trade-id" } },
      },
      {
        label: "recommendation update",
        handler: recommendationItemHandler,
        req: { method: "PATCH", query: { id: "recommendation-id" }, body: {} },
      },
    ];

    for (const item of cases) {
      const res = createResponse();
      await item.handler(item.req, res);
      assert.equal(res.statusCode, 401, item.label);
      assert.deepEqual(res.body, {
        error: true,
        message: "Unauthorized.",
      }, item.label);
    }
  });
});
