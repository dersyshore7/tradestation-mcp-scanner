import assert from "node:assert/strict";
import test from "node:test";
import {
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
