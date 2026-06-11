import assert from "node:assert/strict";
import test from "node:test";
import { listRecentPaperTraderRuns } from "./paperTraderHistory.js";

const originalFetch = globalThis.fetch;
const savedEnv = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

test("run history can be filtered by automation mode", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  let requestedUrl = "";

  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await listRecentPaperTraderRuns(25, {
    includeRawResult: true,
    mode: "live",
  });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/rest/v1/paper_trader_runs");
  assert.equal(url.searchParams.get("mode"), "eq.live");
  assert.equal(url.searchParams.get("limit"), "25");
});
