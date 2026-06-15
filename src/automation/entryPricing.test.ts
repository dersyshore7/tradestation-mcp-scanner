import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBidSideEntryPricing,
  buildMidpointLimitCap,
} from "./entryPricing.js";

test("bid-side entry pricing returns bid plus one tick when it is below midpoint", () => {
  const result = buildBidSideEntryPricing({
    optionSymbol: "AAL 260702C15.5",
    bid: 0.7,
    ask: 0.9,
    mid: 0.8,
  });

  assert.equal(result.pass, true);
  if (result.pass) {
    assert.equal(result.pricing.tickSize, 0.05);
    assert.equal(result.pricing.rawTarget, 0.75);
    assert.equal(result.pricing.finalLimit, 0.75);
    assert.equal(result.pricing.cap, 0.8);
  }
});

test("bid-side entry pricing stays at or below midpoint for tight spreads", () => {
  const result = buildBidSideEntryPricing({
    optionSymbol: "RIVN 260702C17",
    bid: 0.7,
    ask: 0.74,
    mid: 0.72,
  });

  assert.equal(result.pass, true);
  if (result.pass) {
    assert.equal(result.pricing.rawTarget, 0.72);
    assert.equal(result.pricing.finalLimit, 0.7);
    assert.equal(result.pricing.finalLimit <= result.pricing.mid, true);
  }
});

test("bid-side entry pricing uses dime increments for options at or above three dollars", () => {
  const result = buildBidSideEntryPricing({
    optionSymbol: "FCX 260702C68",
    bid: 3.1,
    ask: 3.5,
    mid: 3.3,
  });

  assert.equal(result.pass, true);
  if (result.pass) {
    assert.equal(result.pricing.tickSize, 0.1);
    assert.equal(result.pricing.rawTarget, 3.2);
    assert.equal(result.pricing.finalLimit, 3.2);
  }
});

test("bid-side entry pricing blocks unusable quotes", () => {
  const missingAsk = buildBidSideEntryPricing({
    optionSymbol: "KDP 260717C32",
    bid: 0.7,
    ask: null,
    mid: 0.75,
  });
  assert.equal(missingAsk.pass, false);

  const crossedSpread = buildBidSideEntryPricing({
    optionSymbol: "KDP 260717C32",
    bid: 0.8,
    ask: 0.75,
    mid: 0.775,
  });
  assert.equal(crossedSpread.pass, false);
});

test("midpoint cap floors to a valid option increment", () => {
  assert.equal(
    buildMidpointLimitCap({
      optionSymbol: "RIVN 260702C17",
      mid: 0.72,
    }),
    0.7,
  );
  assert.equal(
    buildMidpointLimitCap({
      optionSymbol: "FCX 260702C68",
      mid: 3.37,
    }),
    3.3,
  );
});
