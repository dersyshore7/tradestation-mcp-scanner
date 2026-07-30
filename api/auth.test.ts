import assert from "node:assert/strict";
import test from "node:test";
import {
  isApiBearerAuthorized,
  requireApiBearerAuth,
} from "./auth.js";
import type {
  VercelRequestLike,
  VercelResponseLike,
} from "./journal/shared.js";

function withSecrets<T>(
  values: { operator?: string; cron?: string },
  run: () => T,
): T {
  const previousOperator = process.env.AUTO_TRADER_API_SECRET;
  const previousCron = process.env.CRON_SECRET;
  if (values.operator) process.env.AUTO_TRADER_API_SECRET = values.operator;
  else delete process.env.AUTO_TRADER_API_SECRET;
  if (values.cron) process.env.CRON_SECRET = values.cron;
  else delete process.env.CRON_SECRET;
  try {
    return run();
  } finally {
    if (previousOperator === undefined) delete process.env.AUTO_TRADER_API_SECRET;
    else process.env.AUTO_TRADER_API_SECRET = previousOperator;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
  }
}

function request(authorization?: string): VercelRequestLike {
  return {
    method: "GET",
    ...(
      authorization
        ? { headers: { authorization } }
        : {}
    ),
  } as VercelRequestLike;
}

test("operator endpoints accept only the operator bearer secret", () => {
  withSecrets({ operator: "operator-secret", cron: "cron-secret" }, () => {
    assert.equal(
      isApiBearerAuthorized(request("Bearer operator-secret")),
      true,
    );
    assert.equal(
      isApiBearerAuthorized(request("Bearer cron-secret")),
      false,
    );
  });
});

test("cron endpoints accept cron or operator bearer credentials", () => {
  withSecrets({ operator: "operator-secret", cron: "cron-secret" }, () => {
    assert.equal(
      isApiBearerAuthorized(request("Bearer cron-secret"), "cron"),
      true,
    );
    assert.equal(
      isApiBearerAuthorized(request("Bearer operator-secret"), "cron"),
      true,
    );
  });
});

test("auth fails closed when no secret is configured", () => {
  withSecrets({}, () => {
    let status = 0;
    let body: unknown = null;
    const response: VercelResponseLike = {
      status(code) {
        status = code;
        return this;
      },
      json(value) {
        body = value;
      },
    };

    assert.equal(requireApiBearerAuth(request(), response), false);
    assert.equal(status, 503);
    assert.deepEqual(body, {
      error: true,
      message: "API bearer authentication is not configured.",
    });
  });
});
