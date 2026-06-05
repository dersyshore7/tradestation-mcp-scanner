import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetTradeStationRequestGovernorForTests,
  createTradeStationFetcher,
  createTradeStationGetFetcher,
} from "./client.js";

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const savedEnv = {
  TRADESTATION_API_KEY: process.env.TRADESTATION_API_KEY,
  TRADESTATION_API_SECRET: process.env.TRADESTATION_API_SECRET,
  TRADESTATION_REFRESH_TOKEN: process.env.TRADESTATION_REFRESH_TOKEN,
  TRADESTATION_SCAN_MIN_INTERVAL_MS: process.env.TRADESTATION_SCAN_MIN_INTERVAL_MS,
  TRADESTATION_SCAN_CACHE_TTL_MS: process.env.TRADESTATION_SCAN_CACHE_TTL_MS,
  TRADESTATION_QUOTA_BACKOFF_MS: process.env.TRADESTATION_QUOTA_BACKOFF_MS,
  TRADESTATION_ACCESS_TOKEN_REFRESH_MARGIN_MS:
    process.env.TRADESTATION_ACCESS_TOKEN_REFRESH_MARGIN_MS,
  TRADESTATION_TOKEN_CACHE_LOCK_MS: process.env.TRADESTATION_TOKEN_CACHE_LOCK_MS,
  TRADESTATION_TOKEN_CACHE_KEY: process.env.TRADESTATION_TOKEN_CACHE_KEY,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

function configureTestEnv(): void {
  process.env.TRADESTATION_API_KEY = "test-key";
  process.env.TRADESTATION_API_SECRET = "test-secret";
  process.env.TRADESTATION_REFRESH_TOKEN = "test-refresh";
  process.env.TRADESTATION_SCAN_MIN_INTERVAL_MS = "0";
  process.env.TRADESTATION_SCAN_CACHE_TTL_MS = "120000";
  process.env.TRADESTATION_QUOTA_BACKOFF_MS = "0";
  process.env.TRADESTATION_ACCESS_TOKEN_REFRESH_MARGIN_MS = "120000";
  process.env.TRADESTATION_TOKEN_CACHE_LOCK_MS = "100";
  delete process.env.TRADESTATION_TOKEN_CACHE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
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

function tokenResponse(accessToken = "test-access-token", expiresIn = 1200): Response {
  return new Response(JSON.stringify({
    access_token: accessToken,
    expires_in: expiresIn,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  tokenHandler: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
    tokenResponse(),
): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/oauth/token")) {
      return await tokenHandler(url, init);
    }
    return await handler(url, init);
  }) as typeof fetch;
}

function readAuthorizationHeader(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("authorization");
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  restoreEnv();
  __resetTradeStationRequestGovernorForTests();
});

test("reuses an access token across fetchers until it is near expiry", async () => {
  configureTestEnv();
  let tokenCalls = 0;
  const authorizationHeaders: (string | null)[] = [];
  installFetchMock(
    (_url, init) => {
      authorizationHeaders.push(readAuthorizationHeader(init));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    () => {
      tokenCalls += 1;
      return tokenResponse(`test-access-token-${tokenCalls}`);
    },
  );

  const firstGet = await createTradeStationGetFetcher();
  const secondGet = await createTradeStationGetFetcher();

  assert.equal(tokenCalls, 0);
  await firstGet("/brokerage/accounts");
  await secondGet("/brokerage/accounts/test-account/balances");

  assert.equal(tokenCalls, 1);
  assert.deepEqual(authorizationHeaders, [
    "Bearer test-access-token-1",
    "Bearer test-access-token-1",
  ]);
});

test("refreshes the access token when it is inside the expiry margin", async () => {
  configureTestEnv();
  process.env.TRADESTATION_ACCESS_TOKEN_REFRESH_MARGIN_MS = "100";
  let now = 1_000_000;
  Date.now = () => now;
  let tokenCalls = 0;
  const authorizationHeaders: (string | null)[] = [];
  installFetchMock(
    (_url, init) => {
      authorizationHeaders.push(readAuthorizationHeader(init));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    () => {
      tokenCalls += 1;
      return tokenResponse(`short-token-${tokenCalls}`, 1);
    },
  );

  const get = await createTradeStationGetFetcher();
  await get("/brokerage/accounts");
  now += 500;
  await get("/brokerage/accounts/test-account/balances");
  now += 450;
  await get("/brokerage/accounts/test-account/positions");

  assert.equal(tokenCalls, 2);
  assert.deepEqual(authorizationHeaders, [
    "Bearer short-token-1",
    "Bearer short-token-1",
    "Bearer short-token-2",
  ]);
});

test("dedupes concurrent in-process token refreshes", async () => {
  configureTestEnv();
  let tokenCalls = 0;
  let apiCalls = 0;
  installFetchMock(
    () => {
      apiCalls += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      tokenCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return tokenResponse("shared-concurrent-token");
    },
  );

  const request = await createTradeStationFetcher();
  await Promise.all([
    request("/brokerage/accounts"),
    request("/brokerage/accounts/test-account/balances"),
    request("/brokerage/accounts/test-account/positions"),
    request("/brokerage/accounts/test-account/orders"),
  ]);

  assert.equal(tokenCalls, 1);
  assert.equal(apiCalls, 4);
});

test("uses a valid Supabase cached token without refreshing", async () => {
  configureTestEnv();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.TRADESTATION_TOKEN_CACHE_KEY = "test-cache-key";
  let tokenCalls = 0;
  let apiAuthorizationHeader: string | null = null;
  installFetchMock(
    (url, init) => {
      if (url.startsWith("https://supabase.test/rest/v1/tradestation_token_cache")) {
        return new Response(JSON.stringify([
          {
            cache_key: "test-cache-key",
            access_token: "supabase-access-token",
            expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
            refresh_locked_until: null,
            updated_at: new Date().toISOString(),
          },
        ]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      apiAuthorizationHeader = readAuthorizationHeader(init);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    () => {
      tokenCalls += 1;
      return tokenResponse("unused-token");
    },
  );

  const get = await createTradeStationGetFetcher();
  await get("/brokerage/accounts");

  assert.equal(tokenCalls, 0);
  assert.equal(apiAuthorizationHeader, "Bearer supabase-access-token");
});

test("uses the Supabase refresh lock before writing a refreshed token", async () => {
  configureTestEnv();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.TRADESTATION_TOKEN_CACHE_KEY = "test-cache-key";
  const seenRequests: string[] = [];
  let apiAuthorizationHeader: string | null = null;
  installFetchMock(
    async (url, init) => {
      if (url.startsWith("https://supabase.test/rest/v1/tradestation_token_cache?on_conflict=")) {
        seenRequests.push("supabase-upsert");
        const body = JSON.parse(String(init?.body)) as { access_token?: string };
        assert.equal(body.access_token, "locked-refresh-token");
        return new Response(JSON.stringify([{ ...body, updated_at: new Date().toISOString() }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.startsWith("https://supabase.test/rest/v1/rpc/try_lock_tradestation_token_cache")) {
        seenRequests.push("supabase-lock");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          p_cache_key: "test-cache-key",
          p_lock_ms: 100,
        });
        return new Response(JSON.stringify(true), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.startsWith("https://supabase.test/rest/v1/tradestation_token_cache")) {
        seenRequests.push("supabase-select");
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      seenRequests.push("tradestation-api");
      apiAuthorizationHeader = readAuthorizationHeader(init);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    () => {
      seenRequests.push("tradestation-token");
      return tokenResponse("locked-refresh-token");
    },
  );

  const get = await createTradeStationGetFetcher();
  await get("/brokerage/accounts");

  assert.deepEqual(seenRequests, [
    "supabase-select",
    "supabase-lock",
    "tradestation-token",
    "supabase-upsert",
    "tradestation-api",
  ]);
  assert.equal(apiAuthorizationHeader, "Bearer locked-refresh-token");
});

test("forces one token refresh and retries after a 401 response", async () => {
  configureTestEnv();
  let tokenCalls = 0;
  const authorizationHeaders: (string | null)[] = [];
  installFetchMock(
    (_url, init) => {
      authorizationHeaders.push(readAuthorizationHeader(init));
      const status = authorizationHeaders.length === 1 ? 401 : 200;
      return new Response(JSON.stringify({ status }), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
    () => {
      tokenCalls += 1;
      return tokenResponse(`retry-token-${tokenCalls}`);
    },
  );

  const get = await createTradeStationGetFetcher();
  const response = await get("/brokerage/accounts");

  assert.equal(response.status, 200);
  assert.equal(tokenCalls, 2);
  assert.deepEqual(authorizationHeaders, [
    "Bearer retry-token-1",
    "Bearer retry-token-2",
  ]);
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
