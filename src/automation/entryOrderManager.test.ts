import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateEntryOrderManagementDecision,
  type AiEntryOrderDecision,
  type EntryOrderManagementContext,
} from "./entryOrderManager.js";

const baseContext: EntryOrderManagementContext = {
  symbol: "PLTR",
  direction: "PUT",
  optionSymbol: "PLTR 260626P135",
  orderId: "956016126",
  orderAgeSeconds: 240,
  filledQuantity: 33,
  remainingQuantity: 19,
  originalLimitPrice: 5.7,
  workingLimitPrice: 5.7,
  averageFillPrice: 5.64,
  optionBid: 5.7,
  optionAsk: 5.9,
  optionMid: 5.8,
  underlyingLast: 136.5,
  intendedStopUnderlying: 138,
  intendedTargetUnderlying: 131,
  plannedRewardRiskR: 2.4,
  accountValueUsd: 100_000,
  entryBuyingPowerUsd: 40_000,
  maxPositionPct: 0.3,
  repriceAttempts: 0,
  lastRepriceAt: null,
  entryThesis: "Bearish continuation",
  nowIso: "2026-06-08T18:10:00.000Z",
};

function decision(input: Partial<AiEntryOrderDecision>): AiEntryOrderDecision {
  return {
    action: "wait",
    newLimitPrice: null,
    confidence: "medium",
    thesis: "test thesis",
    note: "test note",
    plainEnglishExplanation: "test explanation",
    ...input,
  };
}

test("entry order policy allows wait and cancel decisions", () => {
  assert.deepEqual(
    evaluateEntryOrderManagementDecision(baseContext, decision({ action: "wait" }), null),
    {
      allowed: true,
      action: "wait",
      limitPrice: null,
      reason: "test note",
      estimatedRewardRiskR: null,
    },
  );

  assert.deepEqual(
    evaluateEntryOrderManagementDecision(baseContext, decision({ action: "cancel_remaining" }), null),
    {
      allowed: true,
      action: "cancel_remaining",
      limitPrice: null,
      reason: "test note",
      estimatedRewardRiskR: null,
    },
  );
});

test("entry order policy allows balanced repricing inside caps", () => {
  const result = evaluateEntryOrderManagementDecision(
    baseContext,
    decision({ action: "replace_limit", newLimitPrice: 5.9 }),
    5.9,
  );

  assert.equal(result.allowed, true);
  assert.equal(result.action, "replace_limit");
  assert.equal(result.limitPrice, 5.9);
  assert.equal(result.estimatedRewardRiskR, 2.32);
});

test("entry order policy blocks excessive chase and above-ask replacement", () => {
  assert.match(
    evaluateEntryOrderManagementDecision(
      baseContext,
      decision({ action: "replace_limit", newLimitPrice: 7.2 }),
      7.2,
    ).reason,
    /25% above original/,
  );

  assert.match(
    evaluateEntryOrderManagementDecision(
      baseContext,
      decision({ action: "replace_limit", newLimitPrice: 6.0 }),
      6.0,
    ).reason,
    /above current ask/,
  );
});

test("entry order policy blocks wide spread, buying power, and low R reprices", () => {
  assert.match(
    evaluateEntryOrderManagementDecision(
      {
        ...baseContext,
        optionBid: 4.5,
        optionAsk: 5.9,
        optionMid: 5.2,
      },
      decision({ action: "replace_limit", newLimitPrice: 5.8 }),
      5.8,
    ).reason,
    /wider than 20%/,
  );

  assert.match(
    evaluateEntryOrderManagementDecision(
      { ...baseContext, entryBuyingPowerUsd: 1_000 },
      decision({ action: "replace_limit", newLimitPrice: 5.8 }),
      5.8,
    ).reason,
    /buying power/,
  );

  assert.match(
    evaluateEntryOrderManagementDecision(
      { ...baseContext, plannedRewardRiskR: 1.55 },
      decision({ action: "replace_limit", newLimitPrice: 5.9 }),
      5.9,
    ).reason,
    /below 1.50R/,
  );
});

test("entry order policy enforces age, cooldown, and attempt caps", () => {
  assert.match(
    evaluateEntryOrderManagementDecision(
      { ...baseContext, orderAgeSeconds: 30 },
      decision({ action: "replace_limit", newLimitPrice: 5.8 }),
      5.8,
    ).reason,
    /minimum age/,
  );

  assert.match(
    evaluateEntryOrderManagementDecision(
      { ...baseContext, repriceAttempts: 3 },
      decision({ action: "replace_limit", newLimitPrice: 5.8 }),
      5.8,
    ).reason,
    /max is 3/,
  );

  assert.match(
    evaluateEntryOrderManagementDecision(
      { ...baseContext, lastRepriceAt: "2026-06-08T18:09:00.000Z" },
      decision({ action: "replace_limit", newLimitPrice: 5.8 }),
      5.8,
    ).reason,
    /cooldown/,
  );
});
