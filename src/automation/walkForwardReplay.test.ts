import assert from "node:assert/strict";
import test from "node:test";
import { CONTINUATION_CALL_V1 } from "./strategyVersion.js";
import { replayFrozenUnderlyingStrategy, type ReplayBar } from "./walkForwardReplay.js";

const bars: ReplayBar[] = [
  { time: "2026-01-02", open: 100, high: 120, low: 80, close: 100 },
  { time: "2026-01-05", open: 100, high: 102, low: 99, close: 101 },
  { time: "2026-01-06", open: 101, high: 111, low: 100, close: 110 },
];

test("replay never uses the decision bar to manufacture an exit", () => {
  const [result] = replayFrozenUnderlyingStrategy({
    bars,
    candidates: [{
      strategyVersion: CONTINUATION_CALL_V1,
      symbol: "AAPL",
      direction: "CALL",
      decisionTime: "2026-01-02",
      entryUnderlying: 100,
      stopUnderlying: 95,
      targetUnderlying: 110,
      maximumHoldBars: 2,
    }],
  });

  assert.equal(result?.exitTime, "2026-01-06");
  assert.equal(result?.exitReason, "target");
  assert.equal(result?.realizedR, 2);
});

test("simultaneous stop and target bar is resolved conservatively as a loss", () => {
  const [result] = replayFrozenUnderlyingStrategy({
    bars: [
      bars[0]!,
      { time: "2026-01-05", open: 100, high: 112, low: 94, close: 106 },
    ],
    candidates: [{
      strategyVersion: CONTINUATION_CALL_V1,
      symbol: "AAPL",
      direction: "CALL",
      decisionTime: "2026-01-02",
      entryUnderlying: 100,
      stopUnderlying: 95,
      targetUnderlying: 110,
      maximumHoldBars: 1,
    }],
  });

  assert.equal(result?.exitReason, "stop");
  assert.equal(result?.realizedR, -1);
});
