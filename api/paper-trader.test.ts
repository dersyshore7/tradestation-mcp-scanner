import assert from "node:assert/strict";
import test from "node:test";
import handler from "./paper-trader.js";
import type {
  VercelRequestLike,
  VercelResponseLike,
} from "./journal/shared.js";

test("LIVE POST rejects prompt overrides before running a cycle", async () => {
  const previousSecret = process.env.AUTO_TRADER_API_SECRET;
  process.env.AUTO_TRADER_API_SECRET = "operator-secret";
  let statusCode = 0;
  let responseBody: unknown = null;
  const response: VercelResponseLike = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      responseBody = value;
    },
  };

  try {
    await handler({
      method: "POST",
      headers: { authorization: "Bearer operator-secret" },
      query: { mode: "live" },
      body: { prompt: "Use a different strategy" },
    } as VercelRequestLike, response);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.AUTO_TRADER_API_SECRET;
    } else {
      process.env.AUTO_TRADER_API_SECRET = previousSecret;
    }
  }

  assert.equal(statusCode, 400);
  assert.deepEqual(responseBody, {
    error: true,
    message: "LIVE prompt overrides are disabled; LIVE always uses support_resistance_v1.",
  });
});
