import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMultiTimeframeBarsFromLoadedBars,
  fetchFirstUsableDirectOptionQuote,
  runScan,
  summarizeDirectOptionQuoteAttempts,
} from "./runScan.js";

const TRADESTATION_ENV_KEYS = [
  "TRADESTATION_API_KEY",
  "TRADESTATION_API_SECRET",
  "TRADESTATION_REFRESH_TOKEN",
] as const;

async function withTradeStationEnv<T>(
  values: Partial<Record<(typeof TRADESTATION_ENV_KEYS)[number], string>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of TRADESTATION_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const key of TRADESTATION_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function numberedBars(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    Open: index + 1,
    High: index + 2,
    Low: index,
    Close: index + 1.5,
    TotalVolume: 1_000_000 + index,
  }));
}

test("builds multi-timeframe bars from one daily payload and one weekly payload", () => {
  const dailyBars = numberedBars(160);
  const weeklyBars = numberedBars(60);
  const barsByView = buildMultiTimeframeBarsFromLoadedBars({
    dailyBars,
    weeklyBars,
  });

  assert.equal(barsByView["1D"].length, 20);
  assert.equal(barsByView["1W"].length, 35);
  assert.equal(barsByView["1M"].length, 80);
  assert.equal(barsByView["3M"].length, 160);
  assert.equal(barsByView["1Y"].length, 60);
  assert.equal(barsByView["1D"][0]?.Open, 141);
  assert.equal(barsByView["1Y"][0]?.Open, 1);
});

test("option quote attempts preserve quota diagnostics", async () => {
  const get = async () =>
    new Response(JSON.stringify({ Message: "quota exceeded" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });

  const { quote, attempts } = await fetchFirstUsableDirectOptionQuote(
    get,
    ["AAL 260612C14.5"],
  );

  assert.equal(quote, null);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.quotaExceeded, true);
  assert.equal(attempts[0]?.errorMessage, "quota exceeded");
  assert.match(summarizeDirectOptionQuoteAttempts(attempts), /quota exceeded/);
});

test("general scans fail closed instead of returning a mock candidate when TradeStation is unavailable", async () => {
  await withTradeStationEnv({}, async () => {
    const result = await runScan({ prompt: "find bullish setups" });

    assert.equal(result.conclusion, "no_trade_today");
    assert.equal(result.ticker, null);
    assert.equal(result.direction, null);
    assert.equal(result.confidence, null);
    assert.match(result.reason, /failed closed without a fallback candidate/);
    assert.doesNotMatch(result.reason, /Mock bullish signal/);
  });
});
