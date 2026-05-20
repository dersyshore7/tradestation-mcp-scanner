import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ScanResult } from "../app/runScan.js";
import type { JournalTradeDetail } from "../journal/types.js";
import { calculateCloseReviewValues } from "../journal/repository.js";
import {
  buildEntryRewardFeatureInputFromScan,
  buildEntryRewardFeatureSnapshot,
  trainEntryRewardModel,
} from "./entryRewardModel.js";
import { readAutomatedScanStateFromPaperTraderRun } from "./paperTrader.js";
import type { AutomatedEntryScanState } from "./automatedEntryScan.js";
import type { PaperTraderRunRecord } from "./paperTraderHistory.js";

function buildScan(): ScanResult {
  const telemetry = {
    finalSelectionSourceTier: "tier1",
    winningTier: "tier1",
    finalRankingDebug: [
      {
        symbol: "AAPL",
        direction: "bullish",
        scoreInputs: {
          movePct: 1.23456,
          optionSpread: 0.11,
          volumeRatio: 1.44,
          chartReviewScore: 8.9,
        },
      },
    ],
    reviewedFinalistOutcomes: [
      {
        symbol: "AAPL",
        stage2Inputs: {
          targetDte: 19,
          optionSpread: 0.1,
        },
        stage3Inputs: {
          movePct: 1.23456,
          volumeRatio: 1.44,
          chartReviewScore: 8.9,
          structureChecks: [
            "alignment:pass",
            "expansion:pass",
            "body-wick:pass",
            "choppy:fail/mild_caution",
            "continuation:fail/downgrader",
            "pullback-body-control:pass",
            "pullback-volume-control:fail/blocker",
            "trigger-zone-flips:pass",
            "higher-timeframe-room:pass",
            "higher-timeframe-2r-viability:fail/blocker",
          ].join(", "),
        },
        asymmetryDebug: {
          stage3RoomPct: 3.45678,
          preReviewActualRewardRiskRatio: 2.34567,
          postConfirmationActualRewardRiskRatio: 1.23456,
          postConfirmationAsymmetryTier: "tradable",
        },
      },
    ],
  } as unknown as NonNullable<ScanResult["telemetry"]>;

  return {
    ticker: "AAPL",
    direction: "bullish",
    confidence: "85-92",
    conclusion: "confirmed",
    reason: "test scan",
    telemetry,
  };
}

test("paper trader no longer emits scan_in_progress entry outcomes", () => {
  const source = readFileSync(new URL("./paperTrader.ts", import.meta.url), "utf8");

  assert.equal(source.includes('outcome: "scan_in_progress"'), false);
});

test("resumable scan state is loaded from non-entry runs", () => {
  const state: AutomatedEntryScanState = {
    version: 1,
    scanRunId: "paper_scan_test",
    prompt: "scan",
    status: "running",
    tierIndex: 1,
    tierCursor: 20,
    chunkCount: 3,
    scannedSymbolCount: 44,
    startedAt: new Date().toISOString(),
    excludedTickers: [],
    paperLearningPreferences: [],
    confirmedCandidates: [],
    chunkSummaries: [],
    warnings: [],
  };
  const run: PaperTraderRunRecord = {
    id: "run-1",
    created_at: new Date().toISOString(),
    mode: "paper",
    dry_run: false,
    outcome: "no_trade_today",
    symbol: null,
    reason: null,
    raw_result_json: {
      entry: {
        automatedScanState: state,
      },
    },
  };

  assert.deepEqual(readAutomatedScanStateFromPaperTraderRun(run), state);
});

test("close review R math uses proportional cost and risk for partial exits", () => {
  const review = calculateCloseReviewValues({
    contracts: 10,
    option_entry_price: "10",
    position_cost_usd: "10000",
    planned_risk_usd: "1000",
  }, {
    option_exit_price: "12",
    quantity_closed: 5,
    fees_usd: "0",
    slippage_usd: "0",
  });

  assert.equal(review.soldForUsd, 6000);
  assert.equal(review.realizedPlUsd, 1000);
  assert.equal(review.realizedRMultiple, 2);
  assert.equal(review.realizedReturnPct, 20);
});

test("close review R math preserves high raw R when planned risk supports it", () => {
  const review = calculateCloseReviewValues({
    contracts: 1000,
    option_entry_price: "10",
    position_cost_usd: "1000000",
    planned_risk_usd: "1",
  }, {
    option_exit_price: "20",
    quantity_closed: 1000,
    fees_usd: "0",
    slippage_usd: "0",
  });

  assert.equal(review.realizedPlUsd, 1000000);
  assert.equal(review.realizedRMultiple, 1000000);
});

test("entry feature extraction stores compact chart learning context", () => {
  const features = buildEntryRewardFeatureInputFromScan({
    scan: buildScan(),
    entryTimestamp: new Date("2026-05-20T15:00:00.000Z"),
  });
  assert.ok(features);
  const snapshot = buildEntryRewardFeatureSnapshot(features);

  assert.equal(features.chartContext?.continuation, "fail_downgrader");
  assert.equal(features.chartContext?.higherTimeframe2R, "fail_blocker");
  assert.deepEqual(features.chartContext?.failedChecks, [
    "choppy",
    "continuation",
    "pullback_volume_control",
    "higher_timeframe_2r_viability",
  ]);
  assert.equal(features.chartContext?.movePct, 1.235);
  assert.equal(snapshot.buckets.continuationBucket, "fail_downgrader");
  assert.equal(snapshot.buckets.asymmetryTierBucket, "tradable");
  assert.ok(JSON.stringify(snapshot).length < 2000);
});

test("entry reward training uses raw R and chart-context buckets", () => {
  const features = buildEntryRewardFeatureInputFromScan({
    scan: buildScan(),
    entryTimestamp: new Date("2026-05-20T15:00:00.000Z"),
  });
  assert.ok(features);
  const trade = {
    id: "trade-1",
    account_mode: "paper",
    status: "closed",
    symbol: "AAPL",
    direction: "CALL",
    setup_type: "bullish_continuation",
    confidence_bucket: "85-92",
    dte_at_entry: 19,
    entry_day: "Wed",
    entry_time: "10:00:00",
    review: {
      realized_r_multiple: "1234",
    },
    signal_snapshot_json: {
      entryFeatures: buildEntryRewardFeatureSnapshot(features),
    },
  } as unknown as JournalTradeDetail;

  const model = trainEntryRewardModel([trade]);
  const aggregates = Object.values(model.buckets);
  const totalRewards = aggregates.map((bucket) => bucket.totalRewardR);

  assert.equal(model.experienceCount, 1);
  assert.ok(totalRewards.includes(1234));
  assert.ok(Object.keys(model.buckets).some((key) => key.includes("continuation=fail_downgrader")));
  assert.ok(Object.keys(model.buckets).some((key) => key.includes("htf_2r=fail_blocker")));
});
