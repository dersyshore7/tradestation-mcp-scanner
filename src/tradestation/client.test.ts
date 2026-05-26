import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetTradeStationRequestGovernorForTests,
  createTradeStationGetFetcher,
} from "./client.js";

const originalFetch = globalThis.fetch;
const savedEnv = {
  TRADESTATION_API_KEY: process.env.TRADESTATION_API_KEY,
  TRADESTATION_API_SECRET: process.env.TRADESTATION_API_SECRET,
  TRADESTATION_REFRESH_TOKEN: process.env.TRADESTATION_REFRESH_TOKEN,
  TRADESTATION_SCAN_MIN_INTERVAL_MS: process.env.TRADESTATION_SCAN_MIN_INTERVAL_MS,
  TRADESTATION_SCAN_CACHE_TTL_MS: process.env.TRADESTATION_SCAN_CACHE_TTL_MS,
  TRADESTATION_QUOTA_BACKOFF_MS: process.env.TRADESTATION_QUOTA_BACKOFF_MS,
};

function configureTestEnv(): void {
  process.env.TRADESTATION_API_KEY = "test-key";
  process.env.TRADESTATION_API_SECRET = "test-secret";
  process.env.TRADESTATION_REFRESH_TOKEN = "test-refresh";
  process.env.TRADESTATION_SCAN_MIN_INTERVAL_MS = "0";
  process.env.TRADESTATION_SCAN_CACHE_TTL_MS = "120000";
  process.env.TRADESTATION_QUOTA_BACKOFF_MS = "0";
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: "test-access-token" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installFetchMock(handler: (url: string) => Response): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/oauth/token")) {
      return tokenResponse();
    }
    return handler(url);
  }) as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
  __resetTradeStationRequestGovernorForTests();
});

test("retries TradeStation 403 quota exceeded responses", async () => {
  configureTestEnv();
  let apiCalls = 0;
  installFetchMock(() => {
    apiCalls += 1;
    return new Response(JSON.stringify({ Message: "quota exceeded" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  });

  const get = await createTradeStationGetFetcher();
  const response = await get("/marketdata/quotes/AAL");

  assert.equal(response.status, 403);
  assert.equal(apiCalls, 3);
  assert.match(await response.text(), /quota exceeded/);
});

test("does not retry ordinary TradeStation 403 responses", async () => {
  configureTestEnv();
  let apiCalls = 0;
  installFetchMock(() => {
    apiCalls += 1;
    return new Response(JSON.stringify({ Message: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  });

  const get = await createTradeStationGetFetcher();
  const response = await get("/marketdata/quotes/MRK");

  assert.equal(response.status, 403);
  assert.equal(apiCalls, 1);
});

test("caches market-data GET responses with reusable bodies", async () => {
  configureTestEnv();
  let apiCalls = 0;
  installFetchMock(() => {
    apiCalls += 1;
    return new Response(JSON.stringify({ Quotes: [{ Symbol: "AAL" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const get = await createTradeStationGetFetcher();
  const first = await get("/marketdata/quotes/AAL");
  const second = await get("/marketdata/quotes/AAL");

  assert.equal(apiCalls, 1);
  assert.deepEqual(await first.json(), { Quotes: [{ Symbol: "AAL" }] });
  assert.deepEqual(await second.json(), { Quotes: [{ Symbol: "AAL" }] });
});

test("does not cache non-marketdata GET responses", async () => {
  configureTestEnv();
  let apiCalls = 0;
  installFetchMock(() => {
    apiCalls += 1;
    return new Response(JSON.stringify({ Accounts: [{ id: apiCalls }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const get = await createTradeStationGetFetcher();
  await get("/brokerage/accounts");
  await get("/brokerage/accounts");

  assert.equal(apiCalls, 2);
});
