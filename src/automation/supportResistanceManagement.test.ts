import assert from "node:assert/strict";
import test from "node:test";
import { usesFixedSupportResistanceManagement } from "./paperTrader.js";
import {
  LEGACY_STRATEGY_VERSION,
  SUPPORT_RESISTANCE_V1,
} from "./strategyVersion.js";

test("new support/resistance trades use fixed management", () => {
  assert.equal(usesFixedSupportResistanceManagement(SUPPORT_RESISTANCE_V1), true);
});

test("legacy LIVE positions retain their recorded AI management behavior", () => {
  assert.equal(usesFixedSupportResistanceManagement(LEGACY_STRATEGY_VERSION), false);
});
