import assert from "node:assert/strict";
import test from "node:test";
import type { ScanResult } from "../app/runScan.js";
import {
  isSupportResistanceScanEligible,
  SUPPORT_RESISTANCE_PROFILE,
} from "./supportResistanceStrategy.js";
import { SUPPORT_RESISTANCE_V1 } from "./strategyVersion.js";

const confirmedScan: ScanResult = {
  ticker: "AAPL",
  direction: "bullish",
  confidence: "75-84",
  conclusion: "confirmed",
  reason: "Clean support retest with chart-anchored 2:1 room.",
};

test("support/resistance profile has a stable strategy version", () => {
  assert.equal(SUPPORT_RESISTANCE_PROFILE.strategyVersion, SUPPORT_RESISTANCE_V1);
  assert.equal(SUPPORT_RESISTANCE_PROFILE.minimumConfidence, 75);
});

test("support/resistance eligibility accepts confirmed setups at 75 percent or higher", () => {
  assert.equal(isSupportResistanceScanEligible(confirmedScan), true);
  assert.equal(
    isSupportResistanceScanEligible({ ...confirmedScan, confidence: "93-97" }),
    true,
  );
});

test("support/resistance eligibility rejects low confidence or incomplete scans", () => {
  assert.equal(
    isSupportResistanceScanEligible({ ...confirmedScan, confidence: "65-74" }),
    false,
  );
  assert.equal(
    isSupportResistanceScanEligible({
      ...confirmedScan,
      conclusion: "rejected",
    }),
    false,
  );
  assert.equal(
    isSupportResistanceScanEligible({ ...confirmedScan, ticker: null }),
    false,
  );
});
