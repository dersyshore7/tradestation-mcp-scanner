import test from "node:test";
import assert from "node:assert/strict";

import {
  findCandidateLevels,
  selectTradeGeometryFromLevels,
  validateLongPremiumOptionTranslation,
  validateTradeGeometry,
  type Candle,
  type LevelCandidate,
} from "./geometry.js";
import { evaluateChartAnchoredAsymmetryFromBars } from "../app/chartAnchoredTradability.js";

function makeCandle(open: number, high: number, low: number, close: number): Candle {
  return { open, high, low, close, volume: 100_000 };
}

test("bullish: selects validated support below reference and first meaningful resistance above", () => {
  const candidates: LevelCandidate[] = [
    { side: "support", price: 99, timeframe: "1D", sourceType: "swing", touchCount: 3, rejectionStrength: "strong", recency: "recent", brokenOnClose: false, volumeReaction: "clear", confluenceCount: 2, score: 18 },
    { side: "resistance", price: 103, timeframe: "1D", sourceType: "base", touchCount: 2, rejectionStrength: "medium", recency: "recent", brokenOnClose: false, volumeReaction: "clear", confluenceCount: 2, score: 16 },
    { side: "resistance", price: 108, timeframe: "1D", sourceType: "swing", touchCount: 3, rejectionStrength: "strong", recency: "recent", brokenOnClose: false, volumeReaction: "clear", confluenceCount: 2, score: 19 },
  ];

  const selection = selectTradeGeometryFromLevels("bullish", 100, candidates);
  assert.ok(selection.geometry);
  assert.equal(selection.geometry?.invalidation.price, 99);
  assert.equal(selection.geometry?.target.price, 103);
});

test("bearish: selects validated resistance above reference and first meaningful support below", () => {
  const candidates: LevelCandidate[] = [
    { side: "resistance", price: 101, timeframe: "1D", sourceType: "swing", touchCount: 3, rejectionStrength: "strong", recency: "recent", brokenOnClose: false, volumeReaction: "clear", confluenceCount: 2, score: 18 },
    { side: "support", price: 97, timeframe: "1D", sourceType: "base", touchCount: 2, rejectionStrength: "medium", recency: "recent", brokenOnClose: false, volumeReaction: "clear", confluenceCount: 2, score: 15 },
  ];

  const selection = selectTradeGeometryFromLevels("bearish", 100, candidates);
  assert.ok(selection.geometry);
  assert.equal(selection.geometry?.invalidation.price, 101);
  assert.equal(selection.geometry?.target.price, 97);
});

test("inverted ordering fails hard geometry validation", () => {
  const badSelection = selectTradeGeometryFromLevels("bullish", 100, [
    { side: "support", price: 101, timeframe: "1D", sourceType: "swing", touchCount: 2, rejectionStrength: "medium", recency: "recent", brokenOnClose: false, volumeReaction: "none", confluenceCount: 1, score: 10 },
    { side: "resistance", price: 99, timeframe: "1D", sourceType: "swing", touchCount: 2, rejectionStrength: "medium", recency: "recent", brokenOnClose: false, volumeReaction: "none", confluenceCount: 1, score: 10 },
  ]);
  assert.equal(badSelection.geometry, null);
});

test("broken levels are rejected for invalidation selection", () => {
  const selection = selectTradeGeometryFromLevels("bullish", 100, [
    { side: "support", price: 99, timeframe: "1D", sourceType: "swing", touchCount: 3, rejectionStrength: "strong", recency: "recent", brokenOnClose: true, volumeReaction: "clear", confluenceCount: 2, score: 18 },
    { side: "support", price: 98, timeframe: "1D", sourceType: "swing", touchCount: 2, rejectionStrength: "medium", recency: "recent", brokenOnClose: false, volumeReaction: "clear", confluenceCount: 1, score: 14 },
    { side: "resistance", price: 103, timeframe: "1D", sourceType: "swing", touchCount: 2, rejectionStrength: "medium", recency: "recent", brokenOnClose: false, volumeReaction: "clear", confluenceCount: 1, score: 14 },
  ]);
  assert.ok(selection.geometry);
  assert.equal(selection.geometry?.invalidation.price, 98);
});

test("rejects weak real geometry instead of forcing farther level", () => {
  const selection = selectTradeGeometryFromLevels("bullish", 100, [
    { side: "support", price: 99, timeframe: "1D", sourceType: "swing", touchCount: 3, rejectionStrength: "strong", recency: "recent", brokenOnClose: false, volumeReaction: "clear", confluenceCount: 2, score: 18 },
    { side: "resistance", price: 100.8, timeframe: "1D", sourceType: "base", touchCount: 2, rejectionStrength: "medium", recency: "recent", brokenOnClose: false, volumeReaction: "clear", confluenceCount: 2, score: 15 },
    { side: "resistance", price: 104, timeframe: "1D", sourceType: "swing", touchCount: 3, rejectionStrength: "strong", recency: "recent", brokenOnClose: false, volumeReaction: "clear", confluenceCount: 2, score: 17 },
  ]);
  assert.ok(selection.geometry);
  assert.equal(selection.geometry?.target.price, 100.8);
  const validation = validateTradeGeometry("bullish", 100, selection.geometry!);
  assert.equal(validation.pass, false);
});

test("option translation sanity checks fail when premium direction is wrong", () => {
  const invalidationFail = validateLongPremiumOptionTranslation(2.5, 2.7, 3.2);
  assert.equal(invalidationFail.pass, false);
  const targetFail = validateLongPremiumOptionTranslation(2.5, 1.2, 2.4);
  assert.equal(targetFail.pass, false);
});

test("findCandidateLevels + chart result shape stays stable", () => {
  const oneDayBars = [
    makeCandle(99.5, 100.5, 99.1, 100.2),
    makeCandle(100.2, 101.2, 99.8, 100.9),
    makeCandle(100.8, 101.1, 99.4, 99.8),
    makeCandle(99.8, 100.4, 99.2, 100.3),
    makeCandle(100.2, 101.5, 100.0, 101.2),
    makeCandle(101.1, 102.2, 100.7, 101.9),
    makeCandle(101.8, 102.0, 100.2, 100.5),
    makeCandle(100.6, 101.4, 100.1, 101.2),
  ];
  const candidates = findCandidateLevels({ "1D": oneDayBars });
  assert.ok(candidates.length > 0);

  const toBars = (candles: Candle[]) => candles.map((c) => ({ Open: c.open, High: c.high, Low: c.low, Close: c.close, TotalVolume: c.volume }));
  const result = evaluateChartAnchoredAsymmetryFromBars("TEST", "bullish", 101, toBars(oneDayBars), toBars(oneDayBars), toBars(oneDayBars));
  assert.equal(typeof result.pass, "boolean");
  assert.ok("invalidationUnderlying" in result);
  assert.ok("targetUnderlying" in result);
  assert.ok("minimumConfirmableRR" in result);
});
