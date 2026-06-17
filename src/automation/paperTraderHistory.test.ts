import assert from "node:assert/strict";
import test from "node:test";
import { listRecentPaperTraderRuns, recordPaperTraderRun } from "./paperTraderHistory.js";

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

test("run history stores compact broker-truth and live-audit summaries", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify([{
      id: "run-1",
      created_at: "2026-06-17T15:00:00.000Z",
      mode: "live",
      dry_run: false,
      outcome: "managed",
      symbol: null,
      reason: null,
      raw_result_json: requestBody.raw_result_json,
    }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const run = await recordPaperTraderRun({
    mode: "live",
    dryRun: false,
    outcome: "managed",
    symbol: null,
    reason: null,
    rawResult: {
      mode: "live",
      closedExitReconciliation: {
        inspected: 2,
        repaired: 1,
        skipped: 1,
        brokerConfirmedRealizedPlUsd: -247.4,
        journalRealizedPlUsdBefore: -47.5,
        journalRealizedPlUsdAfter: -247.4,
        realizedPlDeltaUsd: -199.9,
        updates: [{ symbol: "ORCL", orderId: "1276059268" }],
        skippedDetails: [{ symbol: "NVDA", reason: "missing order id" }],
        warnings: ["sample warning"],
      },
      liveDailyAudit: {
        date: "2026-06-17",
        journalRealizedPlUsd: -247.4,
        brokerConfirmedRealizedPlUsd: -247.4,
        openUnrealizedPlUsd: 12.34,
        biggestLosers: [{ symbol: "ORCL", realizedPlUsd: -247.4 }],
        winnersExitedBeforeTarget: [{ symbol: "NVDA", progressToTargetPct: 70 }],
        openPositions: [{ symbol: "SOFI 260702C18", unlinked: false }],
        warnings: [],
      },
    },
  });

  assert.notEqual(requestBody, null);
  const compact = ((requestBody as unknown) as Record<string, unknown>).raw_result_json as Record<string, unknown>;
  const closedExitReconciliation = compact.closedExitReconciliation as Record<string, unknown>;
  const liveDailyAudit = compact.liveDailyAudit as Record<string, unknown>;
  const runRawResult = run?.raw_result_json as Record<string, unknown> | null;
  const runClosedExitReconciliation = runRawResult?.closedExitReconciliation as Record<string, unknown> | undefined;
  assert.equal(runClosedExitReconciliation?.repaired, 1);
  assert.equal(closedExitReconciliation.repaired, 1);
  assert.equal(closedExitReconciliation.realizedPlDeltaUsd, -199.9);
  assert.equal(liveDailyAudit.date, "2026-06-17");
});
