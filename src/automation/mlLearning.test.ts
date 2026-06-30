import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildPaperLearningChartStructureBucketsForTest,
  matchesPaperLearningPreferenceForTest,
  type PaperLearningCandidateBuckets,
  type ScanLearningPreference,
  type ScanResult,
  type Stage3CheckDiagnostic,
} from "../app/runScan.js";
import type { AccountMode, JournalTradeDetail } from "../journal/types.js";
import {
  calculateAggregateCloseReviewValues,
  calculateCloseReviewValues,
  calculateRemainingPositionAfterPartialExit,
} from "../journal/repository.js";
import {
  calculateEntryOpportunityRewardR,
  buildEntryRewardFeatureInputFromScan,
  buildEntryRewardFeatureSnapshot,
  recommendEntryPolicy,
  trainEntryRewardModel,
} from "./entryRewardModel.js";
import { buildLearningOutcomeAudit } from "./learningOutcomeAudit.js";
import { buildLearningReviewRepairPlan } from "./learningRepair.js";
import {
  buildAiManagementPromptForTest,
  enforceAiManagementGuardrails,
  normalizeAiManagementDecisionForTest,
  type AiManagementDecision,
} from "./aiManager.js";
import {
  buildPaperLearningTradeSet,
  DEFAULT_PAPER_LEARNING_START_AT,
} from "./paperLearningCutoff.js";
import {
  buildPaperLearningPreferences,
  buildSymbolLearningPenaltyPreferences,
} from "./paperLearningPreferences.js";
import { recommendPolicyAction, trainPolicyModel } from "./policyModel.js";
import { calculateScaleOutQuantity, decideProfitProtection } from "./profitProtection.js";
import {
  readAutomatedScanStateFromPaperTraderRun,
  buildEntryPolicyEffectivenessSummaryForTest,
  buildPaperTraderThesisChecklistForTest,
  chooseJournalExitPriceForTest,
  evaluateOpeningExitGuardForTest,
  evaluateWeekendCarryGuardForTest,
  evaluateWeekendEntryGuardForTest,
  readCloseOrderFillSnapshotForTest,
  readOpeningOrderSnapshotForTest,
  resolveManagementActionAfterProfitProtectionForTest,
  selectResumableAutomatedScanStateFromRuns,
  validateEntryGeometryForTest,
} from "./paperTrader.js";
import {
  canResumeAutomatedEntryScanState,
  type AutomatedEntryScanState,
} from "./automatedEntryScan.js";
import type { PaperEntryCandidateRecord } from "./entryCandidateHistory.js";
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

function buildTradeCardWithGeometry(params: {
  direction: "CALL" | "PUT";
  entry: number;
  stop: number;
  target: number;
}): Parameters<typeof validateEntryGeometryForTest>[0] {
  return {
    plannedJournalFields: {
      direction: params.direction,
      underlying_entry_price: params.entry,
      intended_stop_underlying: params.stop,
      intended_target_underlying: params.target,
    },
  } as Parameters<typeof validateEntryGeometryForTest>[0];
}

function buildAutomatedScanState(
  overrides: Partial<AutomatedEntryScanState> = {},
): AutomatedEntryScanState {
  return {
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
    ...overrides,
  };
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - (minutes * 60 * 1000)).toISOString();
}

function buildPaperTraderRunForTest(params: {
  id: string;
  createdAt: string;
  dryRun?: boolean;
  outcome?: string;
  rawResult: Record<string, unknown>;
}): PaperTraderRunRecord {
  return {
    id: params.id,
    created_at: params.createdAt,
    mode: "live",
    dry_run: params.dryRun ?? false,
    outcome: params.outcome ?? "no_trade_today",
    symbol: null,
    reason: null,
    raw_result_json: params.rawResult,
  };
}

test("paper trader no longer emits scan_in_progress entry outcomes", () => {
  const source = readFileSync(new URL("./paperTrader.ts", import.meta.url), "utf8");

  assert.equal(source.includes('outcome: "scan_in_progress"'), false);
});

test("zero-contract entry blocks preserve resumable scan state", () => {
  const source = readFileSync(new URL("./paperTrader.ts", import.meta.url), "utf8");
  const zeroContractBlock = source.slice(
    source.indexOf("if (positionCap.cappedContracts < 1)"),
    source.indexOf("const initialContracts = positionCap.cappedContracts"),
  );

  assert.match(zeroContractBlock, /outcome: "zero_contract_trade"/);
  assert.match(zeroContractBlock, /automatedScanState: remainingAutomatedScanState/);
});

test("resumable scan state is loaded from non-entry runs", () => {
  const state = buildAutomatedScanState();
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

test("completed scan runs invalidate older running resume state", () => {
  const runningState = buildAutomatedScanState({
    scanRunId: "paper_scan_old_running",
    status: "running",
    scannedSymbolCount: 478,
  });
  const olderRunningRun = buildPaperTraderRunForTest({
    id: "run-older",
    createdAt: "2026-06-24T14:13:51.000Z",
    rawResult: {
      entry: {
        attempted: true,
        outcome: "no_trade_today",
        scanSummary: {
          status: "running",
          scannedSymbolCount: 478,
          totalSymbolCount: 523,
        },
        automatedScanState: runningState,
      },
    },
  });
  const newerCompletedRun = buildPaperTraderRunForTest({
    id: "run-newer",
    createdAt: "2026-06-24T14:17:24.000Z",
    rawResult: {
      entry: {
        attempted: true,
        outcome: "no_trade_today",
        scanSummary: {
          status: "completed",
          scannedSymbolCount: 523,
          totalSymbolCount: 523,
        },
        automatedScanState: null,
      },
    },
  });

  assert.equal(
    selectResumableAutomatedScanStateFromRuns([olderRunningRun, newerCompletedRun], false),
    null,
  );
});

test("latest running scan state remains resumable", () => {
  const runningState = buildAutomatedScanState({
    scanRunId: "paper_scan_latest_running",
    status: "running",
    scannedSymbolCount: 80,
  });
  const latestRunningRun = buildPaperTraderRunForTest({
    id: "run-latest",
    createdAt: minutesAgoIso(5),
    rawResult: {
      entry: {
        attempted: true,
        outcome: "no_trade_today",
        scanSummary: {
          status: "running",
          scannedSymbolCount: 80,
          totalSymbolCount: 523,
        },
        automatedScanState: runningState,
      },
    },
  });

  assert.deepEqual(
    selectResumableAutomatedScanStateFromRuns([latestRunningRun], false),
    runningState,
  );
});

test("newer non-entry runs do not invalidate running scan state", () => {
  const runningState = buildAutomatedScanState({
    scanRunId: "paper_scan_running_before_market",
    status: "running",
    scannedSymbolCount: 80,
  });
  const olderRunningRun = buildPaperTraderRunForTest({
    id: "run-running",
    createdAt: minutesAgoIso(10),
    rawResult: {
      entry: {
        attempted: true,
        outcome: "no_trade_today",
        scanSummary: {
          status: "running",
          scannedSymbolCount: 80,
          totalSymbolCount: 523,
        },
        automatedScanState: runningState,
      },
    },
  });
  const newerOutsideMarketHoursRun = buildPaperTraderRunForTest({
    id: "run-outside-market",
    createdAt: minutesAgoIso(5),
    outcome: "outside_market_hours",
    rawResult: {
      entry: {
        attempted: false,
        outcome: "outside_market_hours",
        symbol: null,
        reason: "Skipped LIVE automation cycle outside regular US equity market hours.",
      },
    },
  });

  assert.deepEqual(
    selectResumableAutomatedScanStateFromRuns([
      newerOutsideMarketHoursRun,
      olderRunningRun,
    ], false),
    runningState,
  );
});

test("automated scan resume tolerates closed symbols falling out of exclusions", () => {
  const state: AutomatedEntryScanState = buildAutomatedScanState({
    tierIndex: 1,
    tierCursor: 20,
    chunkCount: 7,
    scannedSymbolCount: 121,
    excludedTickers: ["BKR", "DRI", "HOOD", "PEP", "SLV"],
  });

  assert.equal(
    canResumeAutomatedEntryScanState(state, {
      prompt: "scan",
      excludedTickers: ["BKR", "DRI", "PEP", "SLV"],
    }),
    true,
  );
});

test("automated scan resume rejects new unscanned open symbols", () => {
  const state: AutomatedEntryScanState = buildAutomatedScanState({
    tierIndex: 0,
    tierCursor: 20,
    chunkCount: 1,
    scannedSymbolCount: 20,
    excludedTickers: [],
  });

  assert.equal(
    canResumeAutomatedEntryScanState(state, {
      prompt: "scan",
      excludedTickers: ["DRI"],
    }),
    false,
  );
});

test("paper trader recognizes alive partial opening orders", () => {
  const snapshot = readOpeningOrderSnapshotForTest({
    OrderID: "956016126",
    StatusDescription: "Partial Fill (Alive)",
    LimitPrice: "5.70",
    OpenedDateTime: "2026-06-08T17:04:47Z",
    Legs: [{
      Symbol: "PLTR 260626P135",
      OpenOrClose: "Open",
      BuyOrSell: "Buy",
      QuantityOrdered: "52",
      ExecQuantity: "8",
      QuantityRemaining: "44",
      ExecutionPrice: "5.64",
    }],
  }, "PLTR 260626P135", "PLTR");

  assert.equal(snapshot?.isAlive, true);
  assert.equal(snapshot?.orderedQuantity, 52);
  assert.equal(snapshot?.filledQuantity, 8);
  assert.equal(snapshot?.remainingQuantity, 44);
  assert.equal(snapshot?.limitPrice, 5.7);
  assert.equal(snapshot?.openedAt, "2026-06-08T17:04:47Z");
  assert.match(snapshot?.description ?? "", /956016126/);

  const sellToClose = readOpeningOrderSnapshotForTest({
    OrderID: "956020270",
    StatusDescription: "Filled",
    Legs: [{
      Symbol: "PLTR 260626P135",
      OpenOrClose: "Close",
      BuyOrSell: "Sell",
      ExecQuantity: "1",
    }],
  }, "PLTR 260626P135", "PLTR");

  assert.equal(sellToClose, null);
});

test("paper trader extracts broker fill prices from close orders", () => {
  const topLevelFill = readCloseOrderFillSnapshotForTest({
    OrderID: "1276059268",
    Status: "FLL",
    StatusDescription: "Filled",
    FilledPrice: "5.65",
    Legs: [{
      Symbol: "ORCL 260702C190",
      Underlying: "ORCL",
      OpenOrClose: "Close",
      BuyOrSell: "Sell",
      ExecQuantity: "1",
      QuantityRemaining: "0",
      ExecutionPrice: "5.60",
    }],
  }, "ORCL 260702C190", "ORCL");

  assert.equal(topLevelFill?.averageFillPrice, 5.65);
  assert.equal(topLevelFill?.filledQuantity, 1);
  assert.match(topLevelFill?.description ?? "", /1276059268/);

  const legFill = readCloseOrderFillSnapshotForTest({
    OrderID: "1276059269",
    StatusDescription: "Filled",
    Legs: [{
      Symbol: "ORCL 260702C190",
      Underlying: "ORCL",
      OpenOrClose: "Close",
      BuyOrSell: "Sell",
      ExecQuantity: "1",
      ExecutionPrice: "5.55",
    }],
  }, "ORCL 260702C190", "ORCL");

  assert.equal(legFill?.averageFillPrice, 5.55);

  const openOrder = readCloseOrderFillSnapshotForTest({
    OrderID: "1275956679",
    StatusDescription: "Filled",
    Legs: [{
      Symbol: "ORCL 260702C190",
      Underlying: "ORCL",
      OpenOrClose: "Open",
      BuyOrSell: "Buy",
      ExecQuantity: "1",
      ExecutionPrice: "8.10",
    }],
  }, "ORCL 260702C190", "ORCL");

  assert.equal(openOrder, null);
});

test("journal exit pricing prefers broker fills and marks quote fallback provisional", () => {
  const brokerPrice = chooseJournalExitPriceForTest({
    brokerAverageFillPrice: 5.65,
    brokerFillSource: "orders",
    optionMid: 7.625,
    optionBid: 7.25,
    entryOptionPrice: 8.1,
  });

  assert.equal(brokerPrice.optionExitPrice, 5.65);
  assert.equal(brokerPrice.source, "orders");
  assert.equal(brokerPrice.note, null);
  assert.equal(
    calculateAggregateCloseReviewValues({
      contracts: 1,
      option_entry_price: "8.10",
      position_cost_usd: "810",
      planned_risk_usd: "89.50",
    }, [{
      option_exit_price: String(brokerPrice.optionExitPrice),
      quantity_closed: 1,
      fees_usd: "0",
      slippage_usd: "0",
    }]).realizedPlUsd,
    -245,
  );

  const provisionalPrice = chooseJournalExitPriceForTest({
    brokerAverageFillPrice: null,
    brokerFillSource: null,
    optionMid: 7.625,
    optionBid: 7.25,
    entryOptionPrice: 8.1,
  });

  assert.equal(provisionalPrice.optionExitPrice, 7.625);
  assert.equal(provisionalPrice.source, "provisional_quote");
  assert.match(provisionalPrice.note ?? "", /provisional/i);
});

test("broker fill repair recomputes ORCL-style stale exit P/L with fees", () => {
  const staleReview = calculateAggregateCloseReviewValues({
    contracts: 1,
    option_entry_price: "8.10",
    position_cost_usd: "810",
    planned_risk_usd: "89.50",
  }, [{
    option_exit_price: "7.625",
    quantity_closed: 1,
    fees_usd: "0",
    slippage_usd: "0",
  }]);
  const brokerReview = calculateAggregateCloseReviewValues({
    contracts: 1,
    option_entry_price: "8.10",
    position_cost_usd: "810",
    planned_risk_usd: "89.50",
  }, [{
    option_exit_price: "5.65",
    quantity_closed: 1,
    fees_usd: "2.40",
    slippage_usd: "0",
  }]);

  assert.equal(staleReview.realizedPlUsd, -47.5);
  assert.equal(brokerReview.realizedPlUsd, -247.4);
  assert.equal(Number((brokerReview.realizedPlUsd - staleReview.realizedPlUsd).toFixed(2)), -199.9);
});

test("paper trader wires closed-exit broker reconciliation without new order placement", () => {
  const source = readFileSync(new URL("./paperTrader.ts", import.meta.url), "utf8");
  const repositorySource = readFileSync(new URL("../journal/repository.ts", import.meta.url), "utf8");

  assert.ok(source.includes("reconcileClosedLiveJournalExits"));
  assert.ok(source.includes("findTradeStationOrderById({ client, accountId, orderId })"));
  assert.ok(source.includes("buildCloseOrderFillSummary"));
  assert.ok(source.includes("Broker-confirmed TradeStation fill"));
  assert.ok(source.includes("closedExitReconciliation"));
  assert.ok(source.includes("exit_price_source: journalExitPrice.source"));
  assert.ok(source.includes("broker_confirmed: isBrokerConfirmedExitPriceSource(journalExitPrice.source)"));
  assert.ok(source.includes("broker_order_id: orderIds || null"));
  assert.ok(repositorySource.includes("updateJournalExitWithBrokerFill"));
  assert.ok(repositorySource.includes("calculateAggregateCloseReviewValues"));
  assert.ok(repositorySource.includes("broker_confirmed: true"));
  assert.ok(repositorySource.includes("broker_repaired: true"));
  assert.ok(repositorySource.includes("broker_order_id: input.brokerOrderId"));
});

test("paper trader preserves AI runners but closes premium-trailing exits", () => {
  const source = readFileSync(new URL("./paperTrader.ts", import.meta.url), "utf8");

  assert.ok(source.includes("Final runner preserved until hard target, stop, time exit, or validated dead-thesis exit."));
  assert.ok(source.includes("Prior scale-out already protected this winner; remaining runner position preserved"));
  assert.ok(source.includes('&& aiDecision.action === "scale_out";'));
  assert.ok(source.includes("profit_protection_exit_full"));
  assert.ok(source.includes('profitProtectionDecision.action === "exit_full"'));
  assert.ok(source.includes('reason: "manual_early_exit"'));
  assert.ok(source.includes("const ruleScaleOut ="));
  assert.ok(source.includes('&& profitProtectionDecision.action === "scale_out";'));
  assert.equal(source.includes("|| managementAction === \"scale_out\""), false);
  assert.equal(
    source.includes('profitProtectionDecision.action === "exit_full"\n          || aiDecision.action === "scale_out"'),
    false,
  );
});

test("paper trader blocks unearned AI scale-outs but preserves validated exits", () => {
  const blockedHold = resolveManagementActionAfterProfitProtectionForTest({
    aiAction: "scale_out",
    profitProtectionAction: "none",
    profitProtectionFullExit: false,
    preserveRunnerPosition: false,
    hasAllowedLevelUpdate: false,
  });
  assert.equal(blockedHold.action, "hold");
  assert.match(blockedHold.blockedAiScaleOutReason ?? "", /profit-protection threshold has not been earned/i);

  const blockedUpdate = resolveManagementActionAfterProfitProtectionForTest({
    aiAction: "scale_out",
    profitProtectionAction: "none",
    profitProtectionFullExit: false,
    preserveRunnerPosition: false,
    hasAllowedLevelUpdate: true,
  });
  assert.equal(blockedUpdate.action, "update_levels");
  assert.match(blockedUpdate.blockedAiScaleOutReason ?? "", /profit-protection threshold has not been earned/i);

  const earnedScaleOut = resolveManagementActionAfterProfitProtectionForTest({
    aiAction: "hold",
    profitProtectionAction: "scale_out",
    profitProtectionFullExit: false,
    preserveRunnerPosition: false,
    hasAllowedLevelUpdate: false,
  });
  assert.equal(earnedScaleOut.action, "scale_out");
  assert.equal(earnedScaleOut.blockedAiScaleOutReason, null);

  const deadThesisExit = resolveManagementActionAfterProfitProtectionForTest({
    aiAction: "exit_now",
    profitProtectionAction: "none",
    profitProtectionFullExit: false,
    preserveRunnerPosition: false,
    hasAllowedLevelUpdate: false,
  });
  assert.equal(deadThesisExit.action, "exit_now");
  assert.equal(deadThesisExit.blockedAiScaleOutReason, null);

  const premiumTrailExit = resolveManagementActionAfterProfitProtectionForTest({
    aiAction: "hold",
    profitProtectionAction: "exit_full",
    profitProtectionFullExit: true,
    preserveRunnerPosition: false,
    hasAllowedLevelUpdate: false,
  });
  assert.equal(premiumTrailExit.action, "exit_now");
  assert.equal(premiumTrailExit.blockedAiScaleOutReason, null);
});

test("live opening exit guard lets stops bypass when configured", () => {
  const bypassed = evaluateOpeningExitGuardForTest({
    accountMode: "live",
    openingStopBypassEnabled: true,
    nowIso: "2026-06-17T13:35:00.000Z",
    decision: {
      reason: "stop_hit",
      note: "Underlying fell to 187.50 at/below stop 187.66.",
    },
    direction: "CALL",
    entryUnderlyingPrice: 189.45,
    currentUnderlyingPrice: 187.5,
    stopUnderlying: 187.66,
    targetUnderlying: 192.14,
    originalStopUnderlying: 187.66,
    entryOptionPrice: 8.1,
    currentOptionMid: 7.5,
  });

  assert.equal(bypassed.blocked, false);

  const guarded = evaluateOpeningExitGuardForTest({
    accountMode: "live",
    openingStopBypassEnabled: false,
    nowIso: "2026-06-17T13:35:00.000Z",
    decision: {
      reason: "stop_hit",
      note: "Underlying fell to 187.50 at/below stop 187.66.",
    },
    direction: "CALL",
    entryUnderlyingPrice: 189.45,
    currentUnderlyingPrice: 187.5,
    stopUnderlying: 187.66,
    targetUnderlying: 192.14,
    originalStopUnderlying: 187.66,
    entryOptionPrice: 8.1,
    currentOptionMid: 7.5,
  });

  assert.equal(guarded.blocked, true);
  assert.match(guarded.note ?? "", /Opening exit guard/);

  const afterWindow = evaluateOpeningExitGuardForTest({
    accountMode: "live",
    openingStopBypassEnabled: false,
    nowIso: "2026-06-17T13:40:00.000Z",
    decision: {
      reason: "stop_hit",
      note: "Underlying fell to 187.50 at/below stop 187.66.",
    },
    direction: "CALL",
    entryUnderlyingPrice: 189.45,
    currentUnderlyingPrice: 187.5,
    stopUnderlying: 187.66,
    targetUnderlying: 192.14,
    originalStopUnderlying: 187.66,
    entryOptionPrice: 8.1,
    currentOptionMid: 7.5,
  });

  assert.equal(afterWindow.blocked, false);

  const paperLane = evaluateOpeningExitGuardForTest({
    accountMode: "paper",
    openingStopBypassEnabled: false,
    nowIso: "2026-06-17T13:35:00.000Z",
    decision: {
      reason: "stop_hit",
      note: "Underlying fell to 187.50 at/below stop 187.66.",
    },
    direction: "CALL",
    entryUnderlyingPrice: 189.45,
    currentUnderlyingPrice: 187.5,
    stopUnderlying: 187.66,
    targetUnderlying: 192.14,
    originalStopUnderlying: 187.66,
    entryOptionPrice: 8.1,
    currentOptionMid: 7.5,
  });

  assert.equal(paperLane.blocked, false);
});

test("live opening exit guard still suppresses targets and non-crash manual exits", () => {
  const target = evaluateOpeningExitGuardForTest({
    accountMode: "live",
    openingStopBypassEnabled: true,
    nowIso: "2026-06-17T13:35:00.000Z",
    decision: {
      reason: "target_hit",
      note: "Underlying reached the target.",
    },
    direction: "CALL",
    entryUnderlyingPrice: 189.45,
    currentUnderlyingPrice: 192.2,
    stopUnderlying: 187.66,
    targetUnderlying: 192.14,
    originalStopUnderlying: 187.66,
    entryOptionPrice: 8.1,
    currentOptionMid: 8.9,
  });
  assert.equal(target.blocked, true);

  const manual = evaluateOpeningExitGuardForTest({
    accountMode: "live",
    openingStopBypassEnabled: true,
    nowIso: "2026-06-17T13:35:00.000Z",
    decision: {
      reason: "manual_early_exit",
      note: "AI manager chose exit-now.",
    },
    direction: "CALL",
    entryUnderlyingPrice: 189.45,
    currentUnderlyingPrice: 187.5,
    stopUnderlying: 187.66,
    targetUnderlying: 192.14,
    originalStopUnderlying: 187.66,
    entryOptionPrice: 8.1,
    currentOptionMid: 7.5,
  });
  assert.equal(manual.blocked, true);
});

test("live opening exit guard allows severe gap or option crash exits", () => {
  const severeGap = evaluateOpeningExitGuardForTest({
    accountMode: "live",
    openingStopBypassEnabled: false,
    nowIso: "2026-06-17T13:35:00.000Z",
    decision: {
      reason: "stop_hit",
      note: "Underlying fell hard through the stop.",
    },
    direction: "CALL",
    entryUnderlyingPrice: 189.45,
    currentUnderlyingPrice: 184,
    stopUnderlying: 187.66,
    targetUnderlying: 192.14,
    originalStopUnderlying: 187.66,
    entryOptionPrice: 8.1,
    currentOptionMid: 6,
  });

  assert.equal(severeGap.blocked, false);

  const optionCrash = evaluateOpeningExitGuardForTest({
    accountMode: "live",
    openingStopBypassEnabled: true,
    nowIso: "2026-06-17T13:35:00.000Z",
    decision: {
      reason: "manual_early_exit",
      note: "Option premium decayed.",
    },
    direction: "CALL",
    entryUnderlyingPrice: 189.45,
    currentUnderlyingPrice: 187.5,
    stopUnderlying: 187.66,
    targetUnderlying: 192.14,
    originalStopUnderlying: 187.66,
    entryOptionPrice: 8.1,
    currentOptionMid: 4.05,
  });

  assert.equal(optionCrash.blocked, false);
});

test("weekend entry guard blocks only live entries after the Friday cutoff", () => {
  const blocked = evaluateWeekendEntryGuardForTest({
    accountMode: "live",
    weekendGuardEnabled: true,
    nowIso: "2026-06-26T19:30:00.000Z",
    entryCutoffMinutesCt: (14 * 60) + 30,
  });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.note ?? "", /blocked new LIVE entries/);

  const beforeCutoff = evaluateWeekendEntryGuardForTest({
    accountMode: "live",
    weekendGuardEnabled: true,
    nowIso: "2026-06-26T19:29:00.000Z",
    entryCutoffMinutesCt: (14 * 60) + 30,
  });
  assert.equal(beforeCutoff.blocked, false);

  const disabled = evaluateWeekendEntryGuardForTest({
    accountMode: "live",
    weekendGuardEnabled: false,
    nowIso: "2026-06-26T19:30:00.000Z",
    entryCutoffMinutesCt: (14 * 60) + 30,
  });
  assert.equal(disabled.blocked, false);

  const paperLane = evaluateWeekendEntryGuardForTest({
    accountMode: "paper",
    weekendGuardEnabled: true,
    nowIso: "2026-06-26T19:30:00.000Z",
    entryCutoffMinutesCt: (14 * 60) + 30,
  });
  assert.equal(paperLane.blocked, false);
});

test("weekend carry guard forces only unprotected live positions after the Friday cutoff", () => {
  const unprotected = evaluateWeekendCarryGuardForTest({
    accountMode: "live",
    weekendGuardEnabled: true,
    nowIso: "2026-06-26T19:45:00.000Z",
    exitCutoffMinutesCt: (14 * 60) + 45,
    profitProtectionState: {},
  });
  assert.equal(unprotected.decision?.reason, "manual_early_exit");
  assert.equal(unprotected.protected, false);
  assert.match(unprotected.decision?.note ?? "", /closed before weekend carry/);

  const peakProtected = evaluateWeekendCarryGuardForTest({
    accountMode: "live",
    weekendGuardEnabled: true,
    nowIso: "2026-06-26T19:45:00.000Z",
    exitCutoffMinutesCt: (14 * 60) + 45,
    profitProtectionState: { peakOptionReturnPct: 20 },
  });
  assert.equal(peakProtected.decision, null);
  assert.equal(peakProtected.protected, true);

  const triggeredProtected = evaluateWeekendCarryGuardForTest({
    accountMode: "live",
    weekendGuardEnabled: true,
    nowIso: "2026-06-26T19:45:00.000Z",
    exitCutoffMinutesCt: (14 * 60) + 45,
    profitProtectionState: { triggeredAt: "2026-06-26T18:00:00.000Z" },
  });
  assert.equal(triggeredProtected.decision, null);
  assert.equal(triggeredProtected.protected, true);

  const beforeCutoff = evaluateWeekendCarryGuardForTest({
    accountMode: "live",
    weekendGuardEnabled: true,
    nowIso: "2026-06-26T19:44:00.000Z",
    exitCutoffMinutesCt: (14 * 60) + 45,
    profitProtectionState: {},
  });
  assert.equal(beforeCutoff.decision, null);

  const paperLane = evaluateWeekendCarryGuardForTest({
    accountMode: "paper",
    weekendGuardEnabled: true,
    nowIso: "2026-06-26T19:45:00.000Z",
    exitCutoffMinutesCt: (14 * 60) + 45,
    profitProtectionState: {},
  });
  assert.equal(paperLane.decision, null);
});

test("weekend entry guard runs after reconciliation and open-trade management", () => {
  const source = readFileSync(new URL("./paperTrader.ts", import.meta.url), "utf8");
  const runCycle = source.slice(
    source.indexOf("export async function runPaperTraderCycle"),
    source.indexOf("const decisionLogTrades"),
  );

  const openReconciliationIndex = runCycle.indexOf("const reconciliation = await reconcileOpenPaperOrders");
  const closedExitReconciliationIndex = runCycle.indexOf("const closedExitReconciliation = await reconcileClosedLiveJournalExits");
  const managementIndex = runCycle.indexOf("const management = await manageOpenPaperTrades");
  const weekendGuardIndex = runCycle.indexOf("const weekendEntryGuard = evaluateWeekendEntryGuard");
  const entryIndex = runCycle.indexOf("await maybeEnterNewPaperTrade");

  assert.ok(openReconciliationIndex >= 0);
  assert.ok(closedExitReconciliationIndex > openReconciliationIndex);
  assert.ok(managementIndex > closedExitReconciliationIndex);
  assert.ok(weekendGuardIndex > managementIndex);
  assert.ok(entryIndex > weekendGuardIndex);
  assert.ok(source.includes("newEntriesAllowed: !weekendEntryGuard.blocked"));
});

test("paper trader cancels partial opening remainders before live exit orders", () => {
  const source = readFileSync(new URL("./paperTrader.ts", import.meta.url), "utf8");

  assert.ok(source.includes("async function cancelOpeningRemainderBeforeExit"));
  assert.ok(source.includes("const scaleRemainderCancel = await cancelOpeningRemainderBeforeExit"));
  assert.ok(source.includes("const exitRemainderCancel = await cancelOpeningRemainderBeforeExit"));
  assert.ok(source.includes("cancel_remaining_before_exit"));
});

test("live automation does not adopt unlinked TradeStation positions", () => {
  const source = readFileSync(new URL("./paperTrader.ts", import.meta.url), "utf8");

  assert.ok(source.includes('params.config.accountMode === "live"'));
  assert.ok(source.includes("Skipped adopting unlinked LIVE position"));
  assert.ok(source.includes("live automation only manages trades it created"));
  assert.ok(source.includes("avoid merging with a manual TradeStation position"));
  assert.ok(source.includes("existing TradeStation LIVE position already holds"));
});

test("automated entry geometry blocks stops tighter than 0.75%", () => {
  const message = validateEntryGeometryForTest(buildTradeCardWithGeometry({
    direction: "CALL",
    entry: 100,
    stop: 99.5,
    target: 102,
  }));

  assert.match(message ?? "", /stop distance is 0\.50%/);
  assert.match(message ?? "", /0\.75% minimum/);
});

test("automated entry geometry keeps direction and reward-risk validation", () => {
  const invalidCall = validateEntryGeometryForTest(buildTradeCardWithGeometry({
    direction: "CALL",
    entry: 100,
    stop: 100.5,
    target: 102,
  }));
  const invalidPut = validateEntryGeometryForTest(buildTradeCardWithGeometry({
    direction: "PUT",
    entry: 100,
    stop: 99.5,
    target: 98,
  }));
  const lowRewardRisk = validateEntryGeometryForTest(buildTradeCardWithGeometry({
    direction: "CALL",
    entry: 100,
    stop: 99,
    target: 101.2,
  }));

  assert.match(invalidCall ?? "", /Bullish CALL geometry is invalid/);
  assert.match(invalidPut ?? "", /Bearish PUT geometry is invalid/);
  assert.match(lowRewardRisk ?? "", /reward\/risk 1\.20R/);
});

test("paper trader guards AI stop tightening until protection is earned", () => {
  const source = readFileSync(new URL("./paperTrader.ts", import.meta.url), "utf8");

  assert.ok(source.includes("AI stop tightening ignored because profit-protection trigger has not been earned."));
  assert.ok(source.includes("effectiveAiStopUnderlying"));
  assert.ok(source.includes("stopProtectionEligible"));
  assert.ok(source.includes("stopUpdateBlockedReason"));
  assert.ok(source.includes("stopSource"));
});

test("paper trader builds structured thesis checklist from entry rationale and levels", () => {
  const checklist = buildPaperTraderThesisChecklistForTest({
    direction: "CALL",
    setupType: "bullish_continuation",
    entryReasoning: {
      conciseReasoning: "Breakout held above prior resistance.",
      whyThisWon: "AAPL survived confirmation and trade-card validation.",
      tradeRationale: "Bullish continuation with clean 2R geometry.",
      optionChosen: "AAPL CALL",
      chartGeometry: null,
    },
    tradeCard: null,
    originalRationale: "Bullish continuation from a clean breakout.",
    invalidationUnderlying: 98.5,
    targetUnderlying: 110,
    timeExitDate: "2026-07-16",
  });

  assert.equal(checklist.setupDirection, "CALL");
  assert.equal(checklist.originalRationale, "Bullish continuation from a clean breakout.");
  assert.match(checklist.mustRemainTrue, /98\.50/);
  assert.match(checklist.mustRemainTrue, /110\.00/);
  assert.ok(checklist.woundedIf.some((item) => item.includes("not fully failed")));
  assert.ok(checklist.deadIf.some((item) => item.includes("98.50")));
});

test("AI management prompt includes thesis checklist and chart-review safeguards", () => {
  const prompt = buildAiManagementPromptForTest({
    symbol: "AAPL",
    direction: "CALL",
    setupType: "bullish_continuation",
    confidenceBucket: "75-84",
    entryDate: "2026-06-24",
    expirationDate: "2026-07-17",
    dteAtEntry: 23,
    underlyingEntryPrice: 100,
    optionEntryPrice: 5,
    currentUnderlyingPrice: 99,
    currentOptionMid: 4.5,
    currentStopUnderlying: 98.5,
    currentTargetUnderlying: 110,
    originalStopUnderlying: 98.5,
    originalTargetUnderlying: 110,
    timeExitDate: "2026-07-16",
    progressToTargetPct: -10,
    optionReturnPct: -10,
    rationale: "Bullish continuation from a clean breakout.",
    thesisChecklist: {
      setupDirection: "CALL",
      setupType: "bullish_continuation",
      originalRationale: "Bullish continuation from a clean breakout.",
      entrySummary: "AAPL survived confirmation and trade-card validation.",
      mustRemainTrue: "AAPL must hold 98.50 and keep a path to 110.00.",
      woundedIf: ["Pullback tests the breakout but does not invalidate it."],
      deadIf: ["Breaks below 98.50 with bearish volume."],
      invalidationUnderlying: 98.5,
      targetUnderlying: 110,
      timeExitDate: "2026-07-16",
    },
    currentChartReviewSummary: "Current multi-timeframe chart conclusion: unavailable.",
    lastManagementNote: null,
    lastManagementThesis: null,
    managementHistorySummary: null,
    policyFeedbackSummary: null,
    trainedPolicySummary: null,
    trainedPolicyRecommendedAction: null,
  });

  assert.match(prompt, /Structured entry thesis checklist/);
  assert.match(prompt, /Fresh read-only multi-timeframe chart review/);
  assert.match(prompt, /unavailability alone cannot be a thesisInvalidationReason/);
  assert.match(prompt, /AAPL must hold 98\.50/);
});

test("paper trader wires fresh chart review into normal management telemetry", () => {
  const source = readFileSync(new URL("./paperTrader.ts", import.meta.url), "utf8");

  assert.ok(source.includes("const chartReview = await readCurrentChartReview"));
  assert.ok(source.includes("const currentChartReviewSummary = buildChartReviewSummary(chartReview);"));
  assert.ok(source.includes("currentChartReviewSummary"));
  assert.ok(source.includes("chartReviewConclusion: chartReview.conclusion"));
  assert.ok(source.includes("thesisChecklist"));
});

test("AI management allows thesis-dead exit with two invalidation reasons", () => {
  const decision = enforceAiManagementGuardrails(
    "CALL",
    95,
    110,
    100,
    buildAiManagementDecision({
      action: "exit_now",
      updatedStopUnderlying: 97,
      thesisStatus: "dead",
      thesisInvalidationReasons: [
        "Higher-timeframe alignment flipped bearish.",
        "Continuation volume broke below the trigger zone.",
      ],
      note: "Exit because the original continuation thesis failed.",
    }),
  );

  assert.equal(decision.action, "exit_now");
  assert.equal(decision.updatedStopUnderlying, null);
  assert.equal(decision.updatedTargetUnderlying, null);
  assert.deepEqual(decision.thesisInvalidationReasons, [
    "Higher-timeframe alignment flipped bearish.",
    "Continuation volume broke below the trigger zone.",
  ]);
});

test("AI management downgrades weak thesis-dead exit to tighter risk", () => {
  const decision = enforceAiManagementGuardrails(
    "CALL",
    95,
    110,
    100,
    buildAiManagementDecision({
      action: "exit_now",
      updatedStopUnderlying: 97,
      thesisStatus: "dead",
      thesisInvalidationReasons: ["Trigger-zone support is being tested."],
      note: "Exit because the trade is red.",
    }),
  );

  assert.equal(decision.action, "update_levels");
  assert.equal(decision.updatedStopUnderlying, 97);
  assert.match(decision.note, /insufficient/i);
});

test("AI management treats wounded thesis as a tightening candidate, not an exit", () => {
  const decision = enforceAiManagementGuardrails(
    "PUT",
    105,
    90,
    100,
    buildAiManagementDecision({
      action: "exit_now",
      updatedStopUnderlying: 103,
      thesisStatus: "wounded",
      thesisInvalidationReasons: ["Option premium is temporarily red."],
      note: "Exit because the trade is uncomfortable.",
    }),
  );

  assert.equal(decision.action, "update_levels");
  assert.equal(decision.updatedStopUnderlying, 103);
  assert.match(decision.note, /need dead plus at least 2 reasons/i);
});

test("AI management normalizes missing or malformed thesis fields predictably", () => {
  const missingFieldsDecision = normalizeAiManagementDecisionForTest({
    action: "hold",
    updatedStopUnderlying: null,
    updatedTargetUnderlying: null,
    confidence: "medium",
    confidencePercent: 61,
    profitChancePercent: null,
    thesis: "Still valid.",
    note: "Keep monitoring.",
    plainEnglishExplanation: "The setup is still valid enough to monitor.",
  });
  const malformedFieldsDecision = normalizeAiManagementDecisionForTest({
    action: "hold",
    updatedStopUnderlying: null,
    updatedTargetUnderlying: null,
    confidence: "medium",
    confidencePercent: 61,
    profitChancePercent: null,
    thesisStatus: "panic",
    thesisInvalidationReasons: ["", "Volume failed.", 3, "Volume failed.", "Support failed."],
    thesis: "Still valid.",
    note: "Keep monitoring.",
    plainEnglishExplanation: "The setup is still valid enough to monitor.",
  });

  assert.equal(missingFieldsDecision.thesisStatus, "intact");
  assert.deepEqual(missingFieldsDecision.thesisInvalidationReasons, []);
  assert.equal(malformedFieldsDecision.thesisStatus, "intact");
  assert.deepEqual(malformedFieldsDecision.thesisInvalidationReasons, [
    "Volume failed.",
    "Support failed.",
  ]);
});

test("paper trader preserves thesis-invalidation evidence on manual early exits", () => {
  const source = readFileSync(new URL("./paperTrader.ts", import.meta.url), "utf8");

  assert.ok(source.includes("formatThesisInvalidationEvidence"));
  assert.ok(source.includes("Thesis invalidated:"));
  assert.ok(source.includes("thesisStatus: aiDecision.thesisStatus"));
  assert.ok(source.includes("thesisInvalidationReasons: aiDecision.thesisInvalidationReasons"));
  assert.ok(source.includes('reason: "manual_early_exit"'));
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

test("entry feature extraction normalizes array chart check telemetry", () => {
  const scan = buildScan();
  const reviewed = scan.telemetry?.reviewedFinalistOutcomes?.[0] as unknown as {
    stage3Inputs: { structureChecks: unknown };
  };
  reviewed.stage3Inputs.structureChecks = [
    { check: "alignment", pass: true, impact: "downgrader" },
    { check: "body-wick", pass: false, impact: "blocker" },
    { check: "continuation", pass: false, impact: "downgrader" },
    { check: "pullback-volume-control", pass: false, impact: "blocker" },
    { check: "trigger-zone-flips", pass: true, impact: "downgrader" },
    { check: "higher-timeframe-2r-viability", pass: false, impact: "blocker" },
  ];

  const features = buildEntryRewardFeatureInputFromScan({
    scan,
    entryTimestamp: new Date("2026-05-20T15:00:00.000Z"),
  });

  assert.ok(features);
  assert.equal(features.chartContext?.alignment, "pass");
  assert.equal(features.chartContext?.bodyWick, "fail_blocker");
  assert.equal(features.chartContext?.continuation, "fail_downgrader");
  assert.equal(features.chartContext?.pullbackVolume, "fail_blocker");
  assert.equal(features.chartContext?.higherTimeframe2R, "fail_blocker");
  assert.deepEqual(features.chartContext?.failedChecks, [
    "body_wick",
    "continuation",
    "pullback_volume_control",
    "higher_timeframe_2r_viability",
  ]);
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

function buildLearningTrade(params: {
  id: string;
  createdAt: string;
  realizedR: number;
  accountMode?: AccountMode;
  symbol?: string;
  managementOptionReturnPct?: number | null;
}): JournalTradeDetail {
  const features = buildEntryRewardFeatureInputFromScan({
    scan: buildScan(),
    entryTimestamp: new Date("2026-05-20T15:00:00.000Z"),
  });
  assert.ok(features);
  const managementOptionReturnPct = params.managementOptionReturnPct === undefined
    ? 5
    : params.managementOptionReturnPct;

  return {
    id: params.id,
    created_at: params.createdAt,
    updated_at: params.createdAt,
    account_mode: params.accountMode ?? "paper",
    status: "closed",
    symbol: params.symbol ?? "AAPL",
    direction: "CALL",
    setup_type: "bullish_continuation",
    confidence_bucket: "85-92",
    dte_at_entry: 19,
    contracts: 2,
    position_cost_usd: "1000",
    option_entry_price: "5",
    planned_risk_usd: "500",
    underlying_entry_price: "100",
    entry_date: params.createdAt.slice(0, 10),
    entry_time: "10:00:00",
    review: {
      realized_r_multiple: String(params.realizedR),
    },
    signal_snapshot_json: {
      entryFeatures: buildEntryRewardFeatureSnapshot(features),
      automation: {
        paperTrader: {
          managementHistory: [
            {
              timestamp: params.createdAt,
              action: "hold",
              progressToTargetPct: 35,
              optionReturnPct: managementOptionReturnPct,
              stopUnderlying: 95,
              currentUnderlyingPrice: 101,
              currentOptionMid: 5.25,
            },
          ],
        },
      },
    },
  } as unknown as JournalTradeDetail;
}

function buildRepairTrade(params: {
  id: string;
  createdAt?: string;
  accountMode?: AccountMode;
  status?: "open" | "closed";
  contracts?: number | null;
  positionCostUsd?: string;
  optionEntryPrice?: string | null;
  plannedRiskUsd?: string | null;
  exits?: {
    option_exit_price: string;
    quantity_closed: number;
    fees_usd?: string;
    slippage_usd?: string;
  }[];
  currentRealizedR?: string | null;
  currentRealizedPlUsd?: string | null;
  currentReturnPct?: string | null;
}): JournalTradeDetail {
  const createdAt = params.createdAt ?? DEFAULT_PAPER_LEARNING_START_AT;
  const exits = (params.exits ?? [
    { option_exit_price: "6", quantity_closed: 2 },
  ]).map((exit, index) => ({
    id: `exit-${params.id}-${index}`,
    trade_id: params.id,
    exit_time: createdAt,
    exit_reason: "manual_early_exit",
    fees_usd: exit.fees_usd ?? "0",
    slippage_usd: exit.slippage_usd ?? "0",
    exit_notes: null,
    ...exit,
  }));

  return {
    id: params.id,
    created_at: createdAt,
    updated_at: createdAt,
    account_mode: params.accountMode ?? "paper",
    entry_date: createdAt.slice(0, 10),
    entry_time: "10:00:00",
    entry_day: "Wed",
    entry_week: "2026-W21",
    symbol: "RPR",
    direction: "CALL",
    setup_type: "bullish_continuation",
    status: params.status ?? "closed",
    contracts: params.contracts ?? 2,
    position_cost_usd: params.positionCostUsd ?? "1000",
    option_entry_price: params.optionEntryPrice === undefined ? "5" : params.optionEntryPrice,
    planned_risk_usd: params.plannedRiskUsd === undefined ? "500" : params.plannedRiskUsd,
    exits,
    latest_exit: exits[0] ?? null,
    review: {
      realized_r_multiple: params.currentRealizedR ?? null,
      realized_pl_usd: params.currentRealizedPlUsd ?? null,
      realized_return_pct: params.currentReturnPct ?? null,
    },
  } as unknown as JournalTradeDetail;
}

function buildStage3ChecksForLearningTest(
  overrides: Partial<Record<string, Partial<Stage3CheckDiagnostic>>> = {},
): Stage3CheckDiagnostic[] {
  const baseChecks: Stage3CheckDiagnostic[] = [
    { check: "expansion", pass: true, reason: "ok", impact: "downgrader" },
    { check: "body-wick", pass: true, reason: "ok", impact: "downgrader" },
    { check: "choppy", pass: false, reason: "flipCount=4", impact: "mild_caution" },
    { check: "continuation", pass: false, reason: "rejection risk", impact: "downgrader" },
    { check: "pullback-body-control", pass: true, reason: "ok", impact: "downgrader" },
    { check: "pullback-volume-control", pass: false, reason: "expanding", impact: "blocker" },
    { check: "trigger-zone-flips", pass: true, reason: "contained", impact: "downgrader" },
    { check: "higher-timeframe-2r-viability", pass: false, reason: "tight", impact: "blocker" },
  ];

  return baseChecks.map((check) => ({
    ...check,
    ...(overrides[check.check] ?? {}),
  }));
}

function buildPreferenceMatchBuckets(
  overrides: Partial<PaperLearningCandidateBuckets> = {},
): PaperLearningCandidateBuckets {
  return {
    direction: "bullish",
    setupType: "bullish_continuation",
    dteBucket: "8_21",
    rewardRiskBucket: "1_1_5r",
    chartScoreBucket: "strong",
    volumeBucket: "expanded",
    optionSpreadBucket: "normal",
    scanTierBucket: "tier1",
    marketRegimeBucket: "scanner_risk_on",
    ...buildPaperLearningChartStructureBucketsForTest(buildStage3ChecksForLearningTest()),
    ...overrides,
  };
}

function buildEntryCandidate(params: {
  id: string;
  paperTradeId?: string | null;
  policyDecision?: string | null;
  decision?: string;
}): PaperEntryCandidateRecord {
  return {
    id: params.id,
    created_at: "2026-05-21T15:00:00.000Z",
    scan_run_id: "scan-test",
    source: "paper_trader",
    dry_run: false,
    symbol: "AAPL",
    decision: params.decision ?? "entered_automation_trade",
    decision_reason: null,
    paper_trade_id: params.paperTradeId ?? null,
    order_id: null,
    direction: "CALL",
    setup_type: "bullish_continuation",
    confidence_bucket: "85-92",
    dte_at_entry: 19,
    planned_reward_risk: "2",
    chart_review_score: "8.9",
    volume_ratio: "1.44",
    option_spread: "0.11",
    market_regime: null,
    scan_tier: "tier1",
    entry_day: "2026-05-21",
    entry_time_bucket: "morning",
    entry_policy_decision: params.policyDecision ?? "favor",
    entry_policy_sample_size: 2,
    entry_policy_average_reward_r: "0.8",
    entry_policy_win_rate: "1",
    entry_policy_matched_key: "test-key",
    entry_policy_summary: null,
    ml_action: null,
    ml_score_adjustment: null,
    selected: true,
    eventual_outcome_trade_id: null,
    feature_json: {},
    scan_json: null,
    trade_card_json: null,
  };
}

function buildAiManagementDecision(
  overrides: Partial<AiManagementDecision> = {},
): AiManagementDecision {
  return {
    action: "hold",
    updatedStopUnderlying: null,
    updatedTargetUnderlying: null,
    confidence: "medium",
    confidencePercent: 65,
    profitChancePercent: null,
    thesisStatus: "intact",
    thesisInvalidationReasons: [],
    thesis: "The original thesis is still being monitored.",
    note: "Hold while the trade remains valid.",
    plainEnglishExplanation: "The trade still has a reasonable recovery path.",
    ...overrides,
  };
}

test("paper learning cutoff excludes the first 14 days from entry and management training", () => {
  const beforeCutoff = buildLearningTrade({
    id: "before-cutoff",
    createdAt: "2026-05-13T18:22:34.660Z",
    realizedR: -5,
  });
  const atCutoff = buildLearningTrade({
    id: "at-cutoff",
    createdAt: DEFAULT_PAPER_LEARNING_START_AT,
    realizedR: 0.25,
  });

  const learning = buildPaperLearningTradeSet([beforeCutoff, atCutoff]);
  const entryModel = trainEntryRewardModel(learning.trades);
  const policyModel = trainPolicyModel(learning.trades);

  assert.equal(learning.excludedLearningTrades, 1);
  assert.deepEqual(learning.trades.map((trade) => trade.id), ["at-cutoff"]);
  assert.equal(entryModel.closedTradeCount, 1);
  assert.equal(entryModel.experienceCount, 1);
  assert.ok(Object.values(entryModel.buckets).every((bucket) => bucket.positiveCount === 1));
  assert.equal(policyModel.closedTradeCount, 1);
  assert.equal(policyModel.experienceCount, 1);
  assert.ok(Object.values(policyModel.buckets).every((bucket) => bucket.hold?.positiveCount === 1));
});

test("learning repair plan recomputes journal R only for current-epoch repairable rows", () => {
  const fullExit = buildRepairTrade({
    id: "repair-full",
    currentRealizedR: null,
    currentRealizedPlUsd: null,
    currentReturnPct: null,
  });
  const partialExits = buildRepairTrade({
    id: "repair-partial",
    exits: [
      { option_exit_price: "6", quantity_closed: 1 },
      { option_exit_price: "4.5", quantity_closed: 1 },
    ],
  });
  const missingRisk = buildRepairTrade({
    id: "missing-risk",
    plannedRiskUsd: null,
  });
  const missingExitPrice = buildRepairTrade({
    id: "missing-exit-price",
    exits: [{ option_exit_price: "", quantity_closed: 2 }],
  });
  const beforeCutoff = buildRepairTrade({
    id: "before-repair-cutoff",
    createdAt: "2026-05-13T18:22:34.660Z",
  });

  const plan = buildLearningReviewRepairPlan([
    fullExit,
    partialExits,
    missingRisk,
    missingExitPrice,
    beforeCutoff,
  ]);
  const byId = new Map(plan.items.map((item) => [item.tradeId, item]));

  assert.equal(plan.scannedTradeCount, 5);
  assert.equal(plan.currentEpochTradeCount, 4);
  assert.equal(plan.repairableCount, 2);
  assert.equal(byId.get("repair-full")?.reason, "repairable");
  assert.equal(byId.get("repair-full")?.repairedRealizedPlUsd, 200);
  assert.equal(byId.get("repair-full")?.repairedRealizedR, 0.4);
  assert.equal(byId.get("repair-partial")?.reason, "repairable");
  assert.equal(byId.get("repair-partial")?.repairedRealizedPlUsd, 50);
  assert.equal(byId.get("repair-partial")?.repairedRealizedR, 0.1);
  assert.equal(byId.get("missing-risk")?.reason, "missing_planned_risk");
  assert.equal(byId.get("missing-exit-price")?.reason, "missing_exit_price");
  assert.equal(byId.has("before-repair-cutoff"), false);
});

test("automation learners include reviewed paper and live trades with source counts", () => {
  const paperTrade = buildLearningTrade({
    id: "paper-learning-trade",
    accountMode: "paper",
    createdAt: "2026-05-20T15:00:00.000Z",
    realizedR: 0.5,
  });
  const liveTrade = buildLearningTrade({
    id: "live-learning-trade",
    accountMode: "live",
    createdAt: "2026-05-21T15:00:00.000Z",
    realizedR: 1.25,
  });

  const entryModel = trainEntryRewardModel([paperTrade, liveTrade]);
  const policyModel = trainPolicyModel([paperTrade, liveTrade]);

  assert.equal(entryModel.closedTradeCount, 2);
  assert.deepEqual(entryModel.sourceCounts, { paper: 1, live: 1 });
  assert.equal(entryModel.experienceCount, 2);
  assert.equal(policyModel.closedTradeCount, 2);
  assert.deepEqual(policyModel.sourceCounts, { paper: 1, live: 1 });
  assert.equal(policyModel.experienceCount, 2);

  const effectiveness = buildEntryPolicyEffectivenessSummaryForTest(
    [paperTrade, liveTrade],
    [
      buildEntryCandidate({ id: "candidate-paper", paperTradeId: paperTrade.id }),
      buildEntryCandidate({ id: "candidate-live", paperTradeId: liveTrade.id }),
      buildEntryCandidate({
        id: "candidate-shadow-block",
        policyDecision: "block",
        decision: "policy_blocked",
      }),
    ],
  );
  const favorBucket = effectiveness.buckets.find((bucket) => bucket.policyDecision === "favor");

  assert.equal(effectiveness.closedCandidates, 2);
  assert.deepEqual(effectiveness.sourceCounts, { paper: 1, live: 1 });
  assert.deepEqual(favorBucket?.sourceCounts, { paper: 1, live: 1 });
  assert.match(effectiveness.summary, /1 paper, 1 live/);
});

test("any positive R counts as a win without creating a strong scanner boost", () => {
  const trades = Array.from({ length: 8 }, (_, index) =>
    buildLearningTrade({
      id: `small-win-${index}`,
      createdAt: `2026-05-${20 + index}T15:00:00.000Z`,
      realizedR: 0.1,
      symbol: `T${index}`,
    })
  );
  const features = buildEntryRewardFeatureInputFromScan({
    scan: buildScan(),
    entryTimestamp: new Date("2026-05-20T15:00:00.000Z"),
  });
  assert.ok(features);

  const model = trainEntryRewardModel(trades);
  const recommendation = recommendEntryPolicy(model, features);
  const preferences = buildPaperLearningPreferences(model);

  assert.equal(recommendation.sampleSize, 8);
  assert.equal(recommendation.averageRewardR, 0.1);
  assert.equal(recommendation.winRate, 1);
  assert.equal(recommendation.decision, "allow");
  assert.deepEqual(preferences, []);
});

test("paper learning preferences include candle and volume setup buckets", () => {
  const trades = Array.from({ length: 8 }, (_, index) =>
    buildLearningTrade({
      id: `strong-candle-volume-${index}`,
      createdAt: `2026-05-${20 + index}T15:00:00.000Z`,
      realizedR: 1.25,
      symbol: `CV${index}`,
    })
  );

  const model = trainEntryRewardModel(trades);
  const preferences = buildPaperLearningPreferences(model);
  const detailedPreference = preferences.find((preference) =>
    preference.volumeBucket === "expanded"
    && preference.bodyWickBucket === "pass"
    && preference.continuationBucket === "fail_downgrader"
    && preference.pullbackVolumeBucket === "fail_blocker"
    && preference.failedCheckBucket === "multi"
  );

  assert.ok(detailedPreference);
  assert.equal(detailedPreference.effect, "boost");
  assert.equal(detailedPreference.decision, "prefer");
  assert.equal(detailedPreference.sampleSize, 8);
});

test("scanner learning preference matching requires detailed candle and volume buckets", () => {
  const preference: ScanLearningPreference = {
    direction: "bullish",
    setupType: "bullish_continuation",
    dteBucket: "8_21",
    rewardRiskBucket: "1_1_5r",
    chartScoreBucket: "strong",
    volumeBucket: "expanded",
    bodyWickBucket: "pass",
    continuationBucket: "fail_downgrader",
    pullbackVolumeBucket: "fail_blocker",
    failedCheckBucket: "multi",
    decision: "prefer",
    effect: "boost",
    scoreAdjustment: 1.25,
    reason: "test preference",
    sampleSize: 8,
    averageRewardR: 1.25,
    winRate: 1,
  };

  assert.equal(
    matchesPaperLearningPreferenceForTest(
      buildPreferenceMatchBuckets(),
      preference,
    ),
    true,
  );
  assert.equal(
    matchesPaperLearningPreferenceForTest(
      buildPreferenceMatchBuckets({ pullbackVolumeBucket: "pass" }),
      preference,
    ),
    false,
  );
  assert.equal(
    matchesPaperLearningPreferenceForTest(
      buildPreferenceMatchBuckets({ volumeBucket: "normal" }),
      preference,
    ),
    false,
  );
});

test("weak candle and volume history creates penalties but not hard blocks", () => {
  const trades = Array.from({ length: 15 }, (_, index) =>
    buildLearningTrade({
      id: `weak-candle-volume-${index}`,
      createdAt: `2026-05-${10 + index}T15:00:00.000Z`,
      realizedR: -2,
      symbol: `WV${index}`,
      managementOptionReturnPct: null,
    })
  );

  const model = trainEntryRewardModel(trades);
  const preferences = buildPaperLearningPreferences(model);
  const detailedPenalty = preferences.find((preference) =>
    preference.decision === "avoid"
    && preference.volumeBucket === "expanded"
    && preference.continuationBucket === "fail_downgrader"
    && preference.pullbackVolumeBucket === "fail_blocker"
  );

  assert.ok(detailedPenalty);
  assert.equal(detailedPenalty.effect, "penalty");
  assert.equal(detailedPenalty.scoreAdjustment, -2);
  assert.equal(preferences.some((preference) => preference.effect === "hard_block"), false);
});

test("learning audit classifies entry quality and emits soft repeated-symbol penalties", () => {
  const nkeTrades = [-1.2, -0.7, -0.4].map((realizedR, index) =>
    buildLearningTrade({
      id: `nke-weak-${index}`,
      createdAt: `2026-06-${10 + index}T15:00:00.000Z`,
      realizedR,
      symbol: "NKE",
      managementOptionReturnPct: null,
    })
  );
  const bkr = buildBkrGivebackTrade();
  const missingRealizedR = buildRepairTrade({ id: "missing-realized-r" });
  const audit = buildLearningOutcomeAudit([...nkeTrades, bkr, missingRealizedR]);
  const bkrClassification = audit.tradeClassifications.find((item) => item.symbol === "BKR");
  const penalties = buildSymbolLearningPenaltyPreferences(audit);
  const nkePenalty = penalties.find((preference) => preference.symbol === "NKE");

  assert.equal(audit.classificationCounts.bad_or_unproven_entry, 3);
  assert.equal(audit.classificationCounts.good_entry_major_giveback, 1);
  assert.equal(audit.missingRealizedRCount, 1);
  assert.match(audit.dataWarnings.join(" "), /missing realized R/);
  assert.equal(bkrClassification?.outcomeClass, "good_entry_major_giveback");
  assert.ok((bkrClassification?.opportunityR ?? 0) > 0);
  assert.ok(nkePenalty);
  assert.equal(nkePenalty.effect, "penalty");
  assert.equal(nkePenalty.decision, "avoid");
  assert.notEqual(nkePenalty.effect, "hard_block");
  assert.equal(
    matchesPaperLearningPreferenceForTest(
      buildPreferenceMatchBuckets({ direction: "bearish" }),
      nkePenalty,
      "NKE",
    ),
    true,
  );
  assert.equal(
    matchesPaperLearningPreferenceForTest(
      buildPreferenceMatchBuckets(),
      nkePenalty,
      "AAPL",
    ),
    false,
  );
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
    entryOptionPrice: 3.2,
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
  assert.equal(decision.state.premiumTrailStopOptionMid, 3.68);
});

test("profit protection keeps original chart stop until a real trigger is earned", () => {
  const decision = decideProfitProtection({
    direction: "CALL",
    quantity: 3,
    entryOptionPrice: 2,
    optionReturnPct: 5,
    progressToTargetPct: 25,
    currentStopUnderlying: 95,
    entryUnderlyingPrice: 100,
    currentUnderlyingPrice: 101,
    currentOptionMid: 2.1,
    nowIso: "2026-05-27T19:40:30.426Z",
  });

  assert.equal(decision.action, "none");
  assert.equal(decision.updatedStopUnderlying, null);
  assert.equal(decision.diagnostics.triggered, false);
  assert.equal(decision.diagnostics.protectionEligible, false);
});

test("profit protection permits breakeven stop after progress plus option-return trigger", () => {
  const decision = decideProfitProtection({
    direction: "CALL",
    quantity: 3,
    entryOptionPrice: 2,
    optionReturnPct: 10,
    progressToTargetPct: 40,
    currentStopUnderlying: 95,
    entryUnderlyingPrice: 100,
    currentUnderlyingPrice: 101,
    currentOptionMid: 2.2,
    nowIso: "2026-05-27T19:45:30.426Z",
  });

  assert.equal(decision.action, "scale_out");
  assert.equal(decision.updatedStopUnderlying, 100);
  assert.equal(decision.diagnostics.triggered, true);
  assert.equal(decision.diagnostics.protectionEligible, true);
  assert.equal(decision.diagnostics.premiumTrailActive, false);
});

test("profit protection keeps earned stops protective without repeating scale-out", () => {
  const decision = decideProfitProtection({
    direction: "CALL",
    quantity: 2,
    entryOptionPrice: 2,
    optionReturnPct: 6,
    progressToTargetPct: 20,
    currentState: {
      triggeredAt: "2026-05-27T19:45:30.426Z",
      scaledOutAt: "2026-05-27T19:46:30.426Z",
    },
    currentStopUnderlying: 101,
    entryUnderlyingPrice: 100,
    currentUnderlyingPrice: 102,
    currentOptionMid: 2.12,
    nowIso: "2026-05-27T19:55:30.426Z",
  });

  assert.equal(decision.action, "none");
  assert.equal(decision.updatedStopUnderlying, 101);
  assert.equal(decision.diagnostics.triggered, false);
  assert.equal(decision.diagnostics.protectionEligible, true);
});

test("single-contract premium trail activates without immediate close at the 20% trigger", () => {
  const decision = decideProfitProtection({
    direction: "CALL",
    quantity: 1,
    entryOptionPrice: 6.2,
    optionReturnPct: 20,
    progressToTargetPct: 58.7,
    currentStopUnderlying: 212.43,
    entryUnderlyingPrice: 215.02,
    currentUnderlyingPrice: 217.44,
    currentOptionMid: 7.44,
    nowIso: "2026-06-22T14:30:00.000Z",
  });

  assert.equal(decision.action, "none");
  assert.equal(decision.remainingQuantity, 1);
  assert.equal(decision.diagnostics.premiumTrailActive, true);
  assert.equal(decision.diagnostics.premiumTrailBreached, false);
  assert.equal(decision.state.premiumTrailActivatedAt, "2026-06-22T14:30:00.000Z");
  assert.equal(decision.state.premiumTrailStopOptionMid, 7.13);
  assert.equal(decision.state.premiumTrailStopReturnPct, 15);
});

test("premium trail ratchets upward with stronger option highs", () => {
  const decision = decideProfitProtection({
    direction: "CALL",
    quantity: 1,
    entryOptionPrice: 6.2,
    optionReturnPct: 37.1,
    progressToTargetPct: 100,
    currentState: {
      triggeredAt: "2026-06-22T14:30:00.000Z",
      premiumTrailActivatedAt: "2026-06-22T14:30:00.000Z",
      premiumTrailStopOptionMid: 7.13,
      premiumTrailStopReturnPct: 15,
    },
    currentStopUnderlying: 215.02,
    entryUnderlyingPrice: 215.02,
    currentUnderlyingPrice: 219.14,
    currentOptionMid: 8.5,
    nowIso: "2026-06-22T14:45:00.000Z",
  });

  assert.equal(decision.action, "none");
  assert.equal(decision.state.premiumTrailStopOptionMid, 7.65);
  assert.equal(decision.state.premiumTrailStopReturnPct, 23.4);
});

test("premium trail breach closes remaining option position", () => {
  const decision = decideProfitProtection({
    direction: "CALL",
    quantity: 1,
    entryOptionPrice: 6.2,
    optionReturnPct: 14.5,
    progressToTargetPct: 43,
    currentState: {
      triggeredAt: "2026-06-22T13:41:11.973Z",
      peakOptionMid: 7.7,
      peakOptionReturnPct: 24.2,
      premiumTrailActivatedAt: "2026-06-22T14:46:00.385Z",
      premiumTrailStopOptionMid: 7.13,
      premiumTrailStopReturnPct: 15,
    },
    currentStopUnderlying: 215.02,
    entryUnderlyingPrice: 215.02,
    currentUnderlyingPrice: 216.79,
    currentOptionMid: 7.1,
    nowIso: "2026-06-22T15:05:00.000Z",
  });

  assert.equal(decision.action, "exit_full");
  assert.equal(decision.remainingQuantity, 0);
  assert.equal(decision.diagnostics.premiumTrailBreached, true);
  assert.match(decision.reason ?? "", /current mid 7\.10 <= protected floor 7\.13 after peak 7\.70/);
});

test("progress-only protection does not activate premium trail below 20% option return", () => {
  const decision = decideProfitProtection({
    direction: "CALL",
    quantity: 1,
    entryOptionPrice: 6.2,
    optionReturnPct: 14.5,
    progressToTargetPct: 43,
    currentStopUnderlying: 212.43,
    entryUnderlyingPrice: 215.02,
    currentUnderlyingPrice: 216.79,
    currentOptionMid: 7.1,
    nowIso: "2026-06-22T13:41:11.973Z",
  });

  assert.equal(decision.action, "none");
  assert.equal(decision.updatedStopUnderlying, 215.02);
  assert.equal(decision.diagnostics.protectionEligible, true);
  assert.equal(decision.diagnostics.premiumTrailActive, false);
  assert.equal(decision.state.premiumTrailActivatedAt, undefined);
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
    entryOptionPrice: 23.55,
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
  assert.equal(multiContract.state.premiumTrailStopOptionMid, 27.08);

  const singleContract = decideProfitProtection({
    direction: "CALL",
    quantity: 1,
    entryOptionPrice: 23.55,
    optionReturnPct: 20,
    progressToTargetPct: null,
    currentStopUnderlying: null,
    entryUnderlyingPrice: 421.1,
    currentUnderlyingPrice: 424.5,
    currentOptionMid: 28.26,
    nowIso: "2026-05-27T19:50:29.284Z",
  });
  assert.equal(singleContract.action, "none");
  assert.equal(singleContract.remainingQuantity, 1);
  assert.equal(singleContract.diagnostics.premiumTrailActive, true);
  assert.equal(singleContract.state.premiumTrailStopOptionMid, 27.08);
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
