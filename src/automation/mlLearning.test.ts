import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ScanResult } from "../app/runScan.js";
import type { JournalTradeDetail } from "../journal/types.js";
import {
  calculateAggregateCloseReviewValues,
  calculateCloseReviewValues,
  calculateRemainingPositionAfterPartialExit,
} from "../journal/repository.js";
import {
  calculateEntryOpportunityRewardR,
  buildEntryRewardFeatureInputFromScan,
  buildEntryRewardFeatureSnapshot,
  trainEntryRewardModel,
} from "./entryRewardModel.js";
import { recommendPolicyAction, trainPolicyModel } from "./policyModel.js";
import { calculateScaleOutQuantity, decideProfitProtection } from "./profitProtection.js";
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

test("entry reward training uses opportunity R and chart-context buckets", () => {
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

function buildBkrGivebackTrade(): JournalTradeDetail {
  return {
    id: "bkr-giveback",
    account_mode: "paper",
    status: "closed",
    symbol: "BKR",
    direction: "CALL",
    setup_type: "bullish_continuation",
    confidence_bucket: "75-84",
    dte_at_entry: 30,
    contracts: 13,
    position_cost_usd: "4160",
    option_entry_price: "3.20",
    planned_risk_usd: "1200",
    underlying_entry_price: "65.385",
    signal_snapshot_json: {
      automation: {
        paperTrader: {
          managementHistory: [
            {
              timestamp: "2026-05-26T19:30:29.822Z",
              action: "hold",
              currentUnderlyingPrice: 67.13,
              currentOptionMid: 3.95,
              progressToTargetPct: 45.6,
              optionReturnPct: 23.4,
              stopUnderlying: 64.53,
              targetUnderlying: 69.21,
              note: "Held profitable trade.",
            },
            {
              timestamp: "2026-05-26T19:35:30.579Z",
              action: "hold",
              currentUnderlyingPrice: 67.13,
              currentOptionMid: 3.95,
              progressToTargetPct: 45.6,
              optionReturnPct: 23.4,
              stopUnderlying: 64.53,
              targetUnderlying: 69.21,
              note: "Held profitable trade.",
            },
            {
              timestamp: "2026-05-26T19:40:30.426Z",
              action: "hold",
              currentUnderlyingPrice: 67.135,
              currentOptionMid: 3.95,
              progressToTargetPct: 45.8,
              optionReturnPct: 23.4,
              stopUnderlying: 64.53,
              targetUnderlying: 69.21,
              note: "Held profitable trade.",
            },
            {
              timestamp: "2026-05-27T13:35:29.818Z",
              action: "hold",
              currentUnderlyingPrice: 64.325,
              currentOptionMid: 2.525,
              progressToTargetPct: -27.7,
              optionReturnPct: -21.1,
              stopUnderlying: 64.53,
              targetUnderlying: 69.21,
              note: "Held until stop.",
            },
          ],
        },
      },
    },
    review: {
      realized_r_multiple: "-0.73",
    },
  } as unknown as JournalTradeDetail;
}

test("profit protection scales out BKR-style winner before giveback", () => {
  const decision = decideProfitProtection({
    direction: "CALL",
    quantity: 13,
    optionReturnPct: 23.4,
    progressToTargetPct: 45.8,
    currentStopUnderlying: 64.53,
    entryUnderlyingPrice: 65.385,
    currentUnderlyingPrice: 67.135,
    currentOptionMid: 3.95,
    nowIso: "2026-05-26T19:40:30.426Z",
  });

  assert.equal(decision.action, "scale_out");
  assert.equal(decision.scaleQuantity, 7);
  assert.equal(decision.remainingQuantity, 6);
  assert.equal(decision.updatedStopUnderlying, 65.39);
  assert.equal(decision.diagnostics.triggered, true);
});

test("BKR replay with scale-out preserves profit instead of learning setup failure", () => {
  const scaled = calculateScaleOutQuantity(13);
  assert.deepEqual(scaled, { scaleQuantity: 7, remainingQuantity: 6 });

  const replay = calculateAggregateCloseReviewValues({
    contracts: 0,
    option_entry_price: "3.20",
    position_cost_usd: "0",
    planned_risk_usd: "1200",
  }, [
    {
      option_exit_price: "3.95",
      quantity_closed: 7,
      fees_usd: "0",
      slippage_usd: "0",
    },
    {
      option_exit_price: "2.525",
      quantity_closed: 6,
      fees_usd: "0",
      slippage_usd: "0",
    },
  ]);

  assert.equal(replay.realizedPlUsd, 120);
  assert.ok((replay.realizedRMultiple ?? 0) > 0);

  const bkr = buildBkrGivebackTrade();
  assert.ok(calculateEntryOpportunityRewardR(bkr, -0.73) > 0);
  const recommendation = recommendPolicyAction(trainPolicyModel([bkr]), {
    direction: "CALL",
    setupType: "bullish_continuation",
    confidenceBucket: "75-84",
    progressToTargetPct: 45.8,
    optionReturnPct: 23.4,
    dteAtEntry: 30,
  });

  assert.equal(recommendation.recommendedAction, "scale_out");
  assert.ok((recommendation.actionSummaries.hold?.averageRewardR ?? 0) < 0);
});

test("profit protection works without target progress for adopted AVGO-style positions", () => {
  const multiContract = decideProfitProtection({
    direction: "CALL",
    quantity: 3,
    optionReturnPct: 20,
    progressToTargetPct: null,
    currentStopUnderlying: null,
    entryUnderlyingPrice: 421.1,
    currentUnderlyingPrice: 424.5,
    currentOptionMid: 28.26,
    nowIso: "2026-05-27T19:50:29.284Z",
  });
  assert.equal(multiContract.action, "scale_out");
  assert.equal(multiContract.scaleQuantity, 2);
  assert.equal(multiContract.remainingQuantity, 1);

  const singleContract = decideProfitProtection({
    direction: "CALL",
    quantity: 1,
    optionReturnPct: 20,
    progressToTargetPct: null,
    currentStopUnderlying: null,
    entryUnderlyingPrice: 421.1,
    currentUnderlyingPrice: 424.5,
    currentOptionMid: 28.26,
    nowIso: "2026-05-27T19:50:29.284Z",
  });
  assert.equal(singleContract.action, "exit_full");
});

test("partial exit math leaves a runner and aggregate final review includes all exits", () => {
  const remaining = calculateRemainingPositionAfterPartialExit({
    contracts: 13,
    option_entry_price: "3.20",
    position_cost_usd: "4160",
  }, 7);
  assert.equal(remaining.remainingContracts, 6);
  assert.equal(remaining.remainingPositionCostUsd, 1920);

  const aggregate = calculateAggregateCloseReviewValues({
    contracts: 0,
    option_entry_price: "3.20",
    position_cost_usd: "0",
    planned_risk_usd: "1200",
  }, [
    {
      option_exit_price: "3.95",
      quantity_closed: 7,
      fees_usd: "0",
      slippage_usd: "0",
    },
    {
      option_exit_price: "2.525",
      quantity_closed: 6,
      fees_usd: "0",
      slippage_usd: "0",
    },
  ]);

  assert.equal(aggregate.soldForUsd, 4280);
  assert.equal(aggregate.realizedPlUsd, 120);
  assert.equal(Number(aggregate.realizedReturnPct?.toFixed(2)), 2.88);
});
