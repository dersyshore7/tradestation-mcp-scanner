import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLossPostMortem,
  normalizeLossPostMortemAiReviewForTest,
  type LossPostMortemTradeInput,
} from "./lossPostMortem.js";

function baseLossTrade(overrides: Partial<LossPostMortemTradeInput> = {}): LossPostMortemTradeInput {
  return {
    id: "trade-1",
    account_mode: "paper",
    symbol: "TEST",
    direction: "CALL",
    status: "closed",
    contracts: 1,
    position_cost_usd: "100.00",
    option_entry_price: "1.00",
    planned_risk_usd: "100.00",
    intended_stop_underlying: "95.0000",
    intended_target_underlying: "110.0000",
    signal_snapshot_json: null,
    review: {
      winner: false,
      realized_pl_usd: "-50.00",
      realized_r_multiple: "-0.50",
      realized_return_pct: "-50.00",
    },
    exits: [
      {
        exit_time: "2026-06-23T15:00:00.000Z",
        exit_reason: "stop_hit",
        option_exit_price: "0.50",
        quantity_closed: 1,
        fees_usd: "0.00",
        slippage_usd: "0.00",
        exit_notes: "Stopped out.",
        exit_price_source: "manual",
        broker_confirmed: false,
        broker_repaired: false,
        broker_order_id: null,
      },
    ],
    ...overrides,
  };
}

test("flags a 20 percent peak loser with no visible protection state", () => {
  const postMortem = buildLossPostMortem(baseLossTrade({
    signal_snapshot_json: {
      automation: {
        paperTrader: {
          managementHistory: [
            {
              timestamp: "2026-06-23T14:00:00.000Z",
              action: "hold",
              optionReturnPct: 25,
              note: "Held winner.",
            },
          ],
        },
      },
    },
  }));

  assert.equal(postMortem.classification, "program_issue_possible");
  assert.equal(postMortem.program_recommendation.recommended, true);
  assert.ok(postMortem.flags.some((flag) => flag.code === "winner_giveback_without_protection"));
});

test("does not call earned protection a program issue when protection is recorded", () => {
  const postMortem = buildLossPostMortem(baseLossTrade({
    exits: [
      {
        exit_time: "2026-06-23T15:00:00.000Z",
        exit_reason: "manual_early_exit",
        option_exit_price: "0.80",
        quantity_closed: 1,
        fees_usd: "0.00",
        slippage_usd: "0.00",
        exit_notes: "Premium trail exit.",
        exit_price_source: "manual",
        broker_confirmed: false,
        broker_repaired: false,
        broker_order_id: null,
      },
    ],
    review: {
      winner: false,
      realized_pl_usd: "-20.00",
      realized_r_multiple: "-0.20",
      realized_return_pct: "-20.00",
    },
    signal_snapshot_json: {
      automation: {
        paperTrader: {
          profitProtectionState: {
            triggeredAt: "2026-06-23T14:00:00.000Z",
            premiumTrailActivatedAt: "2026-06-23T14:00:00.000Z",
            peakOptionReturnPct: 25,
          },
          managementHistory: [
            {
              timestamp: "2026-06-23T14:00:00.000Z",
              action: "hold",
              optionReturnPct: 25,
              stopProtectionEligible: true,
              stopSource: "earned_protection",
              note: "Protected winner.",
            },
          ],
        },
      },
    },
  }));

  assert.notEqual(postMortem.classification, "program_issue_possible");
  assert.equal(postMortem.flags.some((flag) => flag.category === "program"), false);
});

test("uses aggregate multi-exit math instead of latest exit alone", () => {
  const postMortem = buildLossPostMortem(baseLossTrade({
    contracts: 2,
    position_cost_usd: "400.00",
    option_entry_price: "2.00",
    review: {
      winner: false,
      realized_pl_usd: "-50.00",
      realized_r_multiple: "-0.25",
      realized_return_pct: "-12.50",
    },
    signal_snapshot_json: {
      automation: {
        paperTrader: {
          quantity: 2,
        },
      },
    },
    exits: [
      {
        exit_time: "2026-06-23T14:00:00.000Z",
        exit_reason: "partial_profit",
        option_exit_price: "2.50",
        quantity_closed: 1,
        fees_usd: "0.00",
        slippage_usd: "0.00",
        exit_notes: "Partial profit.",
        exit_price_source: "manual",
        broker_confirmed: false,
        broker_repaired: false,
        broker_order_id: null,
      },
      {
        exit_time: "2026-06-23T15:00:00.000Z",
        exit_reason: "stop_hit",
        option_exit_price: "1.00",
        quantity_closed: 1,
        fees_usd: "0.00",
        slippage_usd: "0.00",
        exit_notes: "Runner stopped.",
        exit_price_source: "manual",
        broker_confirmed: false,
        broker_repaired: false,
        broker_order_id: null,
      },
    ],
  }));

  assert.equal(postMortem.flags.some((flag) => flag.code === "aggregate_review_mismatch"), false);
  assert.ok(postMortem.flags.some((flag) => flag.code === "multi_exit_latest_exit_can_mislead"));
});

test("flags review math mismatch across exits", () => {
  const postMortem = buildLossPostMortem(baseLossTrade({
    review: {
      winner: false,
      realized_pl_usd: "-100.00",
      realized_r_multiple: "-1.00",
      realized_return_pct: "-100.00",
    },
  }));

  assert.ok(postMortem.flags.some((flag) => flag.code === "aggregate_review_mismatch"));
  assert.equal(postMortem.classification, "data_quality_issue");
});

test("flags provisional or unconfirmed live exit pricing", () => {
  const postMortem = buildLossPostMortem(baseLossTrade({
    account_mode: "live",
    exits: [
      {
        exit_time: "2026-06-23T15:00:00.000Z",
        exit_reason: "stop_hit",
        option_exit_price: "0.50",
        quantity_closed: 1,
        fees_usd: "0.00",
        slippage_usd: "0.00",
        exit_notes: "Provisional quote.",
        exit_price_source: "provisional_quote",
        broker_confirmed: false,
        broker_repaired: false,
        broker_order_id: null,
      },
    ],
  }));

  assert.equal(postMortem.classification, "data_quality_issue");
  assert.ok(postMortem.flags.some((flag) => flag.code === "live_exit_not_broker_confirmed"));
});

test("flags quantity mismatch against automation quantity", () => {
  const postMortem = buildLossPostMortem(baseLossTrade({
    signal_snapshot_json: {
      automation: {
        paperTrader: {
          filledQuantity: 2,
        },
      },
    },
  }));

  assert.equal(postMortem.classification, "data_quality_issue");
  assert.ok(postMortem.flags.some((flag) => flag.code === "quantity_mismatch"));
});

test("suppresses AI program recommendations without deterministic support", () => {
  const postMortem = buildLossPostMortem(baseLossTrade());
  const aiReview = normalizeLossPostMortemAiReviewForTest({
    narrative: "The trade stopped out based on the saved rows.",
    program_recommendation: {
      recommended: true,
      title: "Change the bot",
      rationale: "Speculative suggestion.",
    },
  }, postMortem);

  assert.equal(postMortem.program_recommendation.recommended, false);
  assert.equal(aiReview.program_recommendation.recommended, false);
});
