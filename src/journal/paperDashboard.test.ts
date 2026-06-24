import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  addDefaultExitTruthForTest,
  buildHoldingPeriodBucketForTest,
  buildHoldingPeriodBucketsForTest,
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
    id: "exit-1",
    trade_id: "trade-1",
    exit_time: "2026-06-18T15:00:00.000Z",
    exit_reason: "manual_early_exit",
    option_exit_price: "1.23",
    quantity_closed: 1,
    fees_usd: "0.00",
    slippage_usd: "0.00",
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

test("holding period bucket derives from Chicago entry and exit dates", () => {
  assert.equal(
    buildHoldingPeriodBucketForTest({
      entryDate: "2026-06-18",
      exitTime: "2026-06-18T20:00:00.000Z",
      status: "closed",
    }),
    "intraday",
  );
  assert.equal(
    buildHoldingPeriodBucketForTest({
      entryDate: "2026-06-18",
      exitTime: "2026-06-19T05:30:00.000Z",
      status: "closed",
    }),
    "overnight",
  );
  assert.equal(
    buildHoldingPeriodBucketForTest({
      entryDate: "2026-06-18",
      exitTime: "2026-06-21T15:00:00.000Z",
      status: "closed",
    }),
    "multi_day",
  );
  assert.equal(
    buildHoldingPeriodBucketForTest({
      entryDate: "2026-06-18",
      exitTime: null,
      status: "open",
    }),
    "open",
  );
  assert.equal(
    buildHoldingPeriodBucketForTest({
      entryDate: "bad-date",
      exitTime: "2026-06-18T20:00:00.000Z",
      status: "closed",
    }),
    "unknown",
  );
  assert.equal(
    buildHoldingPeriodBucketForTest({
      entryDate: "2026-06-18",
      exitTime: "bad-timestamp",
      status: "closed",
    }),
    "unknown",
  );
});

test("holding period dashboard buckets include open trades and closed P/L", () => {
  const buckets = buildHoldingPeriodBucketsForTest([
    {
      status: "closed",
      holding_period_bucket: "intraday",
      review: {
        winner: true,
        realized_pl_usd: "100.00",
        realized_r_multiple: "1.5",
        realized_return_pct: "12.5",
      },
    },
    {
      status: "closed",
      holding_period_bucket: "overnight",
      review: {
        winner: false,
        realized_pl_usd: "-50.00",
        realized_r_multiple: "-0.5",
        realized_return_pct: "-6.25",
      },
    },
    {
      status: "open",
      holding_period_bucket: "open",
      position_cost_usd: "300.00",
      review: null,
    },
  ]);
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  assert.equal(byKey.get("open")?.label, "Open");
  assert.equal(byKey.get("open")?.trade_count, 1);
  assert.equal(byKey.get("open")?.open_trade_count, 1);
  assert.equal(byKey.get("open")?.open_position_cost_usd, 300);
  assert.equal(byKey.get("intraday")?.closed_trade_count, 1);
  assert.equal(byKey.get("intraday")?.winner_count, 1);
  assert.equal(byKey.get("intraday")?.realized_pl_usd, 100);
  assert.equal(byKey.get("overnight")?.closed_trade_count, 1);
  assert.equal(byKey.get("overnight")?.loser_count, 1);
  assert.equal(byKey.get("overnight")?.realized_pl_usd, -50);
});
