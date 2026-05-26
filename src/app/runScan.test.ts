import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMultiTimeframeBarsFromLoadedBars,
  fetchFirstUsableDirectOptionQuote,
  summarizeDirectOptionQuoteAttempts,
} from "./runScan.js";

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
