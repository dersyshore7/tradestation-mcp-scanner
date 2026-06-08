import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReplaceOrderPayloadForTest,
  calculateBuyingPowerAdjustedOrderQuantity,
  extractOrderRejectReason,
  isTradeStationOrderRejected,
  normalizeTradeStationOrderPrice,
} from "./tradestation.js";

test("normalizes option buy limits to TradeStation nickel and dime increments", () => {
  assert.equal(
    normalizeTradeStationOrderPrice({
      symbol: "EW 260618C85",
      price: 2.98,
      tradeAction: "BUYTOOPEN",
    }),
    3,
  );
  assert.equal(
    normalizeTradeStationOrderPrice({
      symbol: "KDP 260618C40",
      price: 0.93,
      tradeAction: "BUYTOOPEN",
    }),
    0.95,
  );
  assert.equal(
    normalizeTradeStationOrderPrice({
      symbol: "BKR 260618C65",
      price: 3.25,
      tradeAction: "BUYTOOPEN",
    }),
    3.3,
  );
});

test("normalizes option sell limits down to valid increments", () => {
  assert.equal(
    normalizeTradeStationOrderPrice({
      symbol: "KDP 260618C40",
      price: 0.98,
      tradeAction: "SELLTOCLOSE",
    }),
    0.95,
  );
  assert.equal(
    normalizeTradeStationOrderPrice({
      symbol: "BKR 260618C65",
      price: 3.35,
      tradeAction: "SELLTOCLOSE",
    }),
    3.3,
  );
});

test("keeps non-option prices on penny increments", () => {
  assert.equal(
    normalizeTradeStationOrderPrice({
      symbol: "AAPL",
      price: 298.971,
      tradeAction: "BUY",
    }),
    298.98,
  );
});

test("recognizes compact TradeStation rejection statuses", () => {
  assert.equal(isTradeStationOrderRejected({ status: "REJ", rejectReason: null }), true);
  assert.equal(isTradeStationOrderRejected({ status: "Rejected", rejectReason: null }), true);
  assert.equal(
    isTradeStationOrderRejected({
      status: "REJ",
      rejectReason: "Day trading margin rules.",
    }),
    true,
  );
  assert.equal(isTradeStationOrderRejected({ status: "OK", rejectReason: null }), false);
});

test("does not treat TradeStation sent-order messages as rejections", () => {
  const payload = {
    Orders: [
      {
        OrderID: "955965524",
        Message: "Sent order: Buy to Open 39 AMZN 260626P247.5 @ 7.50 Limit",
      },
    ],
  };

  const rejectReason = extractOrderRejectReason(payload);
  assert.equal(rejectReason, null);
  assert.equal(isTradeStationOrderRejected({ status: null, rejectReason }), false);
});

test("calculates closest lower quantity from TradeStation buying-power rejection", () => {
  const adjustment = calculateBuyingPowerAdjustedOrderQuantity({
    originalQuantity: 49,
    rejectReason:
      "ECL1000: This order requires $16,524.00 of Day Trade Buying Power and $16,524.00 of Overnight Buying Power. This exceeds your current Buying Power values of $16,359.00 for Day Trade and $16,359.00 for Overnight.",
  });

  assert.equal(adjustment?.quantity, 48);
  assert.equal(adjustment?.limitingBuyingPower, "Day Trade");
  assert.equal(adjustment?.requiredDayTradeBuyingPowerUsd, 16524);
  assert.equal(adjustment?.currentDayTradeBuyingPowerUsd, 16359);
});

test("uses the stricter overnight buying-power limit when resizing", () => {
  const adjustment = calculateBuyingPowerAdjustedOrderQuantity({
    originalQuantity: 10,
    rejectReason:
      "This order requires $10,000.00 of Day Trade Buying Power and $10,000.00 of Overnight Buying Power. This exceeds your current Buying Power values of $9,000.00 for Day Trade and $7,000.00 for Overnight.",
  });

  assert.equal(adjustment?.quantity, 7);
  assert.equal(adjustment?.limitingBuyingPower, "Overnight");
});

test("does not resize buying-power rejections below one contract", () => {
  const adjustment = calculateBuyingPowerAdjustedOrderQuantity({
    originalQuantity: 2,
    rejectReason:
      "This order requires $1,000.00 of Day Trade Buying Power and $1,000.00 of Overnight Buying Power. This exceeds your current Buying Power values of $400.00 for Day Trade and $400.00 for Overnight.",
  });

  assert.equal(adjustment, null);
});

test("builds TradeStation cancel-replace limit payloads", () => {
  assert.deepEqual(
    buildReplaceOrderPayloadForTest({
      symbol: "PLTR 260626P135",
      quantity: 19,
      orderType: "Limit",
      limitPrice: 5.03,
    }),
    {
      Symbol: "PLTR 260626P135",
      Quantity: "19",
      OrderType: "Limit",
      LimitPrice: "5.10",
    },
  );
});
