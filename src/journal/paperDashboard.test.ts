import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  addDefaultExitTruthForTest,
  buildPaperDashboardBrokerAuditForTest,
} from "./paperDashboard.js";

test("paper dashboard broker audit uses structured exit truth fields", () => {
  const audit = buildPaperDashboardBrokerAuditForTest([
    {
      exit_price_source: "manual",
      broker_confirmed: false,
      broker_repaired: false,
    },
    {
      exit_price_source: "provisional_quote",
      broker_confirmed: false,
      broker_repaired: false,
    },
    {
      exit_price_source: "orders",
      broker_confirmed: true,
      broker_repaired: false,
    },
    {
      exit_price_source: "broker_legacy_note",
      broker_confirmed: true,
      broker_repaired: true,
    },
  ]);

  assert.deepEqual(audit, {
    provisional_exit_count: 1,
    broker_confirmed_exit_count: 2,
    broker_repaired_exit_count: 1,
  });
});

test("exit truth migration adds columns and backfills legacy note patterns", () => {
  const migration = readFileSync(
    new URL("../../supabase/migrations/202606180001_journal_exit_truth_fields.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /add column if not exists exit_price_source text not null default 'manual'/);
  assert.match(migration, /add column if not exists broker_confirmed boolean not null default false/);
  assert.match(migration, /add column if not exists broker_repaired boolean not null default false/);
  assert.match(migration, /add column if not exists broker_order_id text null/);
  assert.match(migration, /exit_notes ilike '%provisional%'/);
  assert.match(migration, /exit_notes ilike '%broker-confirmed tradestation fill%'/);
});

test("pending migration fallback keeps legacy exit notes out of broker truth counts", () => {
  const fallbackExit = addDefaultExitTruthForTest({
    trade_id: "trade-1",
    exit_time: "2026-06-18T15:00:00.000Z",
    exit_reason: "manual_early_exit",
    option_exit_price: "1.23",
    quantity_closed: 1,
    exit_notes: "Broker-confirmed TradeStation fill 123 and provisional quote text.",
  });

  assert.equal(fallbackExit.exit_price_source, "manual");
  assert.equal(fallbackExit.broker_confirmed, false);
  assert.equal(fallbackExit.broker_repaired, false);
  assert.deepEqual(buildPaperDashboardBrokerAuditForTest([fallbackExit]), {
    provisional_exit_count: 0,
    broker_confirmed_exit_count: 0,
    broker_repaired_exit_count: 0,
  });
});
