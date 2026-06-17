import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateJournalTradeCreatePayload } from "../journal/validation.js";
import type { StarterUniverseTelemetry } from "./runScan.js";
import type { TradeConstructionResult } from "./runTradeConstruction.js";
import {
  buildCompletedOriginalProcessTradeResponse,
  buildMarketRowsFromTelemetry,
  parseAiJson,
  validateAiConfirmationOutput,
  validateAiSelectionOutput,
  type OriginalProcessAiConfirmation,
  type OriginalProcessAiSelection,
  type OriginalProcessSelectedContext,
  type OriginalProcessState,
} from "./originalProcess.js";

function sampleState(): OriginalProcessState {
  return {
    version: 1,
    scanRunId: "original_process_test",
    status: "running",
    tierIndex: 3,
    tierCursor: 0,
    chunkCount: 1,
    scannedSymbolCount: 1,
    startedAt: "2026-06-17T00:00:00.000Z",
    marketRows: [
      {
        symbol: "AAPL",
        tier: "tier1",
        tierLabel: "Tier 1",
        direction: "bullish",
        confidence: "75-84",
        conclusion: "confirmed",
        rankingScore: 12,
        lastPrice: 200,
        averageVolume: 10000000,
        targetExpiration: "2026-07-02",
        targetDte: 15,
        optionOpenInterest: 1200,
        optionSpread: 0.2,
        optionMid: 2.5,
        movePct: 2.1,
        volumeRatio: 1.4,
        chartReviewScore: 11,
        chartSummary: "clean continuation",
        structureChecks: "expansion, volume, 2R room",
        rewardRiskRatio: 2.1,
        invalidationLevel: 196,
        targetLevel: 208,
        reason: "sample candidate",
      },
    ],
    chunkSummaries: [],
    latestDataHealth: null,
  };
}

function sampleTradeCard(): TradeConstructionResult {
  return {
    ticker: "AAPL",
    direction: "bullish",
    confidence: "75-84",
    expectedTiming: "Next 1-3 trading days.",
    buy: "2x AAPL 260702C00200000 @ $2.50 limit",
    invalidationExit: "Exit if AAPL breaks 196.00.",
    takeProfitExit: "Take profit near AAPL 208.00.",
    timeExit: "Exit on Thursday before expiration.",
    rrMath: "Option approximation: risk/contract $50.00, reward/contract $100.00.",
    rationale: "Clean bullish continuation on rising volume.",
    plannedJournalFields: {
      symbol: "AAPL",
      direction: "CALL",
      expiration_date: "2026-07-02",
      dte_at_entry: 15,
      position_cost_usd: 500,
      underlying_entry_price: 200,
      planned_risk_usd: 100,
      planned_profit_usd: 200,
      setup_type: "bullish_continuation",
      confidence_bucket: "75-84",
      intended_stop_underlying: 196,
      intended_target_underlying: 208,
    },
    automationMetadata: {
      optionSymbol: "AAPL 260702C00200000",
      contracts: 2,
      optionLimitPrice: 2.5,
      expirationDate: "2026-07-02",
      dteAtEntry: 15,
      underlyingEntryPrice: 200,
      intendedStopUnderlying: 196,
      intendedTargetUnderlying: 208,
      timeExitDate: "2026-07-01",
      entryOrderType: "Limit",
      entryTradeAction: "BUYTOOPEN",
    },
  };
}

test("AI selection validation rejects invalid JSON, outside tickers, and sub-65 confidence", () => {
  const rows = sampleState().marketRows;
  assert.throws(() => parseAiJson("not json"), /valid JSON object/);
  assert.throws(
    () => validateAiSelectionOutput({
      status: "selected",
      ticker: "ZZZZ",
      direction: "bullish",
      confidencePercent: 80,
      reason: "outside universe",
    }, rows),
    /outside the configured scan universe/,
  );
  assert.throws(
    () => validateAiSelectionOutput({
      status: "selected",
      ticker: "AAPL",
      direction: "bullish",
      confidencePercent: 60,
      reason: "too weak",
    }, rows),
    />= 65%/,
  );
});

test("AI confirmation validation allows rejected confirmation and rejects confirmed below 75", () => {
  const rejected = validateAiConfirmationOutput({
    conclusion: "rejected",
    direction: "bullish",
    confidencePercent: 68,
    confidenceBand: "65-74",
    reason: "inconsistent volume",
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reason, "inconsistent volume");

  assert.throws(
    () => validateAiConfirmationOutput({
      conclusion: "confirmed",
      direction: "bullish",
      confidencePercent: 70,
      confidenceBand: "65-74",
      reason: "not enough confidence",
    }),
    />= 75%/,
  );
});

test("market packet compaction preserves candlestick, volume, and option facts", () => {
  const telemetry = {
    reviewedFinalistOutcomes: [
      {
        symbol: "AAPL",
        tier: "tier1",
        tierLabel: "Tier 1",
        direction: "bullish",
        confidence: "75-84",
        candidateConfirmedInPrompt2: true,
        candidateBlockedPostConfirmation: false,
        blockedConfirmationReason: null,
        tierAbandonedAfterBlock: false,
        scanContinuedAfterBlock: false,
        survivedFinalSelection: true,
        confirmationFailureReasons: [],
        rankingScore: 13.21,
        stage1Inputs: { lastPrice: 200.12, averageVolume: 1234567 },
        stage2Inputs: {
          targetExpiration: "2026-07-02",
          targetDte: 15,
          optionOpenInterest: 900,
          optionSpread: 0.15,
          optionMid: 2.45,
        },
        stage3Inputs: {
          direction: "bullish",
          movePct: 2.42,
          volumeRatio: 1.37,
          chartReviewScore: 11.5,
          chartReviewSummary: "expansion candle held near highs",
          structureChecks: "body/wick pass, volume pass",
          roomToTargetDecision: "2R room sufficient",
        },
        asymmetryDebug: {
          finalizedTradeRewardRiskRatio: 2.04,
          finalizedTradeInvalidationLevel: 196.1,
          finalizedTradeTargetLevel: 208.2,
        },
        conclusion: "confirmed",
        reason: "confirmed continuation",
      },
    ],
    finalRankingDebug: [
      {
        symbol: "AAPL",
        direction: "bullish",
        score: 13.21,
        enteredFinalRanking: true,
        topRankedCandidate: true,
        confirmedFinalSelection: true,
        selected: true,
        selectedFieldMeaning: "final selected trade",
        reason: "ranked candidate",
        scoreInputs: {
          movePct: 2.42,
          optionOpenInterest: 900,
          optionSpread: 0.15,
          optionMid: 2.45,
          volumeRatio: 1.37,
          chartReviewScore: 11.5,
          continuationPass: true,
          continuationPenalty: 0,
        },
      },
    ],
    stage3PassedDetails: [
      {
        symbol: "AAPL",
        direction: "bullish",
        score: 11.5,
        summary: "expansion candle held near highs",
        whyPassed: "body/wick pass, volume pass",
      },
    ],
  } as unknown as StarterUniverseTelemetry;

  const rows = buildMarketRowsFromTelemetry(telemetry, "tier1", "Tier 1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.symbol, "AAPL");
  assert.equal(rows[0]?.volumeRatio, 1.37);
  assert.equal(rows[0]?.optionOpenInterest, 900);
  assert.equal(rows[0]?.structureChecks, "body/wick pass, volume pass");
  assert.equal(rows[0]?.rewardRiskRatio, 2.04);
});

test("completed trade response journalPlannedTrade is compatible with journal create validation", () => {
  const selection: OriginalProcessAiSelection = {
    status: "selected",
    ticker: "AAPL",
    direction: "bullish",
    confidencePercent: 80,
    confidence: "75-84",
    reason: "clean continuation",
  };
  const confirmation: OriginalProcessAiConfirmation = {
    status: "confirmed",
    direction: "bullish",
    confidencePercent: 80,
    confidence: "75-84",
    reason: "pattern and volume support 2R",
  };
  const selectedContext: OriginalProcessSelectedContext = {
    ticker: "AAPL",
    timeframes: [],
    loadError: null,
  };
  const tradeCard = sampleTradeCard();
  const response = buildCompletedOriginalProcessTradeResponse({
    state: sampleState(),
    scan: {
      ticker: "AAPL",
      direction: "bullish",
      confidence: "75-84",
      conclusion: "confirmed",
      reason: "confirmed",
      telemetry: null,
    },
    tradeCard,
    selection,
    confirmation,
    selectedContext,
    serverValidationReason: "server confirmed",
  });

  assert.deepEqual(response.journalPlannedTrade, tradeCard.plannedJournalFields);
  const payload = validateJournalTradeCreatePayload({
    account_mode: "paper",
    entry_date: "2026-06-17",
    contracts: 2,
    option_entry_price: 2.5,
    planned_trade: response.journalPlannedTrade,
    signal_snapshot_json: { originalProcess: response.originalProcess },
  });
  assert.equal(payload.planned_trade.symbol, "AAPL");
  assert.equal(payload.planned_trade.direction, "CALL");
});

test("Original Process source does not introduce TradeStation order endpoints", () => {
  const source = readFileSync(new URL("./originalProcess.ts", import.meta.url), "utf8");
  assert.equal(source.includes("/orders"), false);
  assert.equal(source.includes("placeOrder"), false);
});
