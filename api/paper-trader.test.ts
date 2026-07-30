import assert from "node:assert/strict";
import test from "node:test";
import handler from "./paper-trader.js";
import type {
  VercelRequestLike,
  VercelResponseLike,
} from "./journal/shared.js";

test("LIVE POST rejects prompt overrides before running a cycle", async () => {
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

  await handler({
    method: "POST",
    query: { mode: "live" },
    body: { prompt: "Use a different strategy" },
  } as VercelRequestLike, response);

  assert.equal(statusCode, 400);
  assert.deepEqual(responseBody, {
    error: true,
    message: "LIVE prompt overrides are disabled; LIVE always uses support_resistance_v1.",
  });
});
