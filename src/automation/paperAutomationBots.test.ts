import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LEGACY_PAPER_AUTOMATION_KEY,
  VIRTUAL_PAPER_AUTOMATION_BOTS,
  VIRTUAL_PAPER_AUTOMATION_STARTING_BALANCE_USD,
  getVirtualPaperAutomationBot,
  isVirtualPaperAutomationKey,
  readPaperAutomationKey,
  readVirtualPaperAutomationKey,
} from "./paperAutomationBots.js";
import { loadFmpCongressionalTradeSignals, loadFmpStockNews } from "./fmpSources.js";

test("paper automation registry keeps legacy and virtual bot keys explicit", () => {
  assert.equal(readPaperAutomationKey("legacy_paper_trader"), LEGACY_PAPER_AUTOMATION_KEY);
  assert.equal(readPaperAutomationKey("politician-replica"), "politician_replica");
  assert.equal(readVirtualPaperAutomationKey("news_reasoning_ai"), "news_reasoning_ai");
  assert.equal(readVirtualPaperAutomationKey("legacy_paper_trader"), null);
  assert.equal(readPaperAutomationKey("unknown_bot"), null);
  assert.equal(isVirtualPaperAutomationKey("leaps_investor_ai"), true);
  assert.equal(isVirtualPaperAutomationKey(LEGACY_PAPER_AUTOMATION_KEY), false);
});

test("virtual paper bots all start with isolated ten-thousand-dollar books", () => {
  assert.equal(VIRTUAL_PAPER_AUTOMATION_STARTING_BALANCE_USD, 10_000);
  assert.deepEqual(
    VIRTUAL_PAPER_AUTOMATION_BOTS.map((bot) => [bot.key, bot.startingBalanceUsd]),
    [
      ["politician_replica", 10_000],
      ["news_reasoning_ai", 10_000],
      ["leaps_investor_ai", 10_000],
      ["support_resistance_ai", 10_000],
    ],
  );
  assert.equal(getVirtualPaperAutomationBot("support_resistance_ai").strategyKind, "support_resistance");
});

test("paper automation migration adds scoped keys and indexes", () => {
  const migration = readFileSync(
    new URL("../../supabase/migrations/202607130001_paper_automation_keys.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /journal_trades\s+add column if not exists paper_automation_key text not null default 'legacy_paper_trader'/);
  assert.match(migration, /paper_trader_runs\s+add column if not exists paper_automation_key text not null default 'legacy_paper_trader'/);
  assert.match(migration, /paper_entry_candidates\s+add column if not exists paper_automation_key text not null default 'legacy_paper_trader'/);
  assert.match(migration, /idx_journal_trades_account_automation/);
  assert.match(migration, /idx_paper_trader_runs_mode_automation_created/);
  assert.match(migration, /idx_paper_entry_candidates_automation_created/);
});

test("FMP-backed source loaders warn instead of throwing when API key is absent", async () => {
  const previous = process.env.FMP_API_KEY;
  delete process.env.FMP_API_KEY;
  try {
    const [congress, news] = await Promise.all([
      loadFmpCongressionalTradeSignals(5),
      loadFmpStockNews(5),
    ]);
    assert.deepEqual(congress.items, []);
    assert.deepEqual(news.items, []);
    assert.match(congress.warning ?? "", /Missing FMP_API_KEY/);
    assert.match(news.warning ?? "", /Missing FMP_API_KEY/);
  } finally {
    if (previous === undefined) {
      delete process.env.FMP_API_KEY;
    } else {
      process.env.FMP_API_KEY = previous;
    }
  }
});

test("virtual paper runner does not call TradeStation order placement methods", () => {
  const source = readFileSync(new URL("./virtualPaperTrader.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.placeOrder\(/);
  assert.doesNotMatch(source, /\.confirmOrder\(/);
  assert.doesNotMatch(source, /\.replaceOrder\(/);
  assert.doesNotMatch(source, /\.cancelOrder\(/);
});
