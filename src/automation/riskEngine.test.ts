import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LIVE_RISK_LIMITS } from "./config.js";
import {
  evaluateLiveHealth,
  evaluatePortfolioEntryGuard,
  type PortfolioRiskPosition,
} from "./riskEngine.js";

const base = {
  accountValueUsd: 10_000,
  startOfDayAccountValueUsd: 10_000,
  realizedTodayUsd: 0,
  openUnrealizedUsd: 0,
  entriesToday: 0,
  positions: [] as PortfolioRiskPosition[],
  candidate: {
    symbol: "AAPL",
    direction: "CALL" as const,
    premiumCostUsd: 400,
    plannedRiskUsd: 80,
  },
  limits: DEFAULT_LIVE_RISK_LIMITS,
  liveHealthAllowed: true,
};

test("portfolio guard accepts a candidate exactly within every capital limit", () => {
  const result = evaluatePortfolioEntryGuard({
    ...base,
    candidate: {
      ...base.candidate,
      premiumCostUsd: 500,
      plannedRiskUsd: 100,
    },
  });

  assert.equal(result.allowed, true);
});

test("portfolio guard has no one-contract exception", () => {
  const result = evaluatePortfolioEntryGuard({
    ...base,
    accountValueUsd: 3_400,
    candidate: {
      ...base.candidate,
      premiumCostUsd: 175,
      plannedRiskUsd: 35,
    },
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockReasons.join(" "), /per-position limit/);
});

test("portfolio guard blocks unlinked broker positions and missing exposure", () => {
  const result = evaluatePortfolioEntryGuard({
    ...base,
    positions: [{
      symbol: "MSFT 260821C500",
      direction: null,
      premiumExposureUsd: null,
      plannedRiskUsd: null,
      linkedJournalTradeId: null,
    }],
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockReasons.join(" "), /not linked/);
  assert.match(result.blockReasons.join(" "), /Premium exposure is unavailable/);
});

test("portfolio guard blocks each position and aggregate capital limit", () => {
  const existing: PortfolioRiskPosition = {
    symbol: "MSFT",
    direction: "PUT",
    premiumExposureUsd: 650,
    plannedRiskUsd: 140,
    linkedJournalTradeId: "trade-1",
  };
  const result = evaluatePortfolioEntryGuard({
    ...base,
    positions: [existing],
    candidate: {
      ...base.candidate,
      premiumCostUsd: 501,
      plannedRiskUsd: 101,
    },
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockReasons.join(" "), /per-position limit/);
  assert.match(result.blockReasons.join(" "), /aggregate premium limit/);
  assert.match(result.blockReasons.join(" "), /aggregate planned-risk limit/);
});

test("portfolio guard blocks duplicate contracts and the two-position cap", () => {
  const result = evaluatePortfolioEntryGuard({
    ...base,
    positions: [
      {
        symbol: "AAPL",
        direction: "PUT",
        premiumExposureUsd: 250,
        plannedRiskUsd: 50,
        linkedJournalTradeId: "trade-1",
      },
      {
        symbol: "MSFT",
        direction: "PUT",
        premiumExposureUsd: 250,
        plannedRiskUsd: 50,
        linkedJournalTradeId: "trade-2",
      },
    ],
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockReasons.join(" "), /already open/);
  assert.match(result.blockReasons.join(" "), /Open-position cap/);
});

test("portfolio guard fails closed when account or daily P/L data is missing", () => {
  const result = evaluatePortfolioEntryGuard({
    ...base,
    accountValueUsd: null,
    startOfDayAccountValueUsd: null,
    realizedTodayUsd: null,
    openUnrealizedUsd: null,
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockReasons.join(" "), /net liquidation is unavailable/);
  assert.match(result.blockReasons.join(" "), /Start-of-day account value is unavailable/);
  assert.match(result.blockReasons.join(" "), /Daily realized or open unrealized P\/L is unavailable/);
});

test("July 7 concentration pattern is rejected after one same-direction trade and two entries", () => {
  const positions: PortfolioRiskPosition[] = [{
    symbol: "NVDA",
    direction: "CALL",
    premiumExposureUsd: 450,
    plannedRiskUsd: 90,
    linkedJournalTradeId: "trade-1",
  }];
  const result = evaluatePortfolioEntryGuard({
    ...base,
    entriesToday: 2,
    positions,
    candidate: {
      symbol: "TSLA",
      direction: "CALL",
      premiumCostUsd: 400,
      plannedRiskUsd: 80,
    },
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockReasons.join(" "), /Daily entry cap/);
  assert.match(result.blockReasons.join(" "), /CALL position cap/);
});

test("daily loss combines realized and open unrealized P/L", () => {
  const result = evaluatePortfolioEntryGuard({
    ...base,
    realizedTodayUsd: -60,
    openUnrealizedUsd: -40,
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockReasons.join(" "), /loss limit/);
});

test("live health independently blocks entries", () => {
  const result = evaluatePortfolioEntryGuard({
    ...base,
    liveHealthAllowed: false,
    liveHealthReason: "Rolling strategy health is below the required threshold.",
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockReasons.join(" "), /Rolling strategy health/);
});

test("live health halts at drawdown and poor rolling profit factor", () => {
  const result = evaluateLiveHealth({
    realizedPlUsd: Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? 25 : -50),
    equityPeakUsd: 10_000,
    currentEquityUsd: 9_500,
    limits: DEFAULT_LIVE_RISK_LIMITS,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.rollingProfitFactor, 0.5);
  assert.equal(result.blockReasons.length, 2);
});
