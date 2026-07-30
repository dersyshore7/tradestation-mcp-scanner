import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateStrategyValidationSummary,
  type StrategyShadowTradeRecord,
} from "./strategyValidation.js";
import { CONTINUATION_CALL_V1 } from "./strategyVersion.js";

function buildTrades(params: {
  count: number;
  lossEvery?: number;
  dataQuality?: StrategyShadowTradeRecord["data_quality"];
}): StrategyShadowTradeRecord[] {
  return Array.from({ length: params.count }, (_, index) => {
    const loss = params.lossEvery ? (index + 1) % params.lossEvery === 0 : false;
    const day = new Date(Date.UTC(2026, 0, 1 + index));
    return {
      id: String(index),
      strategy_version: CONTINUATION_CALL_V1,
      session_date: day.toISOString().slice(0, 10),
      entry_time: day.toISOString(),
      status: "closed",
      realized_pl_usd: String(loss ? -50 : 25),
      realized_r_multiple: String(loss ? -1 : 0.5),
      data_quality: params.dataQuality ?? "usable",
    };
  });
}

test("strict validation promotes only a broad profitable forward sample", () => {
  const validation = calculateStrategyValidationSummary(
    CONTINUATION_CALL_V1,
    buildTrades({ count: 100, lossEvery: 5 }),
  );

  assert.equal(validation.profitFactor, 2);
  assert.equal(validation.tradingDays, 100);
  assert.equal(validation.promotable, true);
});

test("one dominant winner fails outlier contribution", () => {
  const trades = buildTrades({ count: 100, lossEvery: 5 });
  trades[99] = {
    ...trades[99]!,
    realized_pl_usd: "10000",
    realized_r_multiple: "100",
  };
  const validation = calculateStrategyValidationSummary(CONTINUATION_CALL_V1, trades);

  assert.equal(
    validation.gates.find((gate) => gate.key === "outlier_contribution")?.passed,
    false,
  );
  assert.equal(validation.promotable, false);
});

test("provisional and missing quote trades reduce completeness and never count as evidence", () => {
  const usable = buildTrades({ count: 94, lossEvery: 5 });
  const provisional = buildTrades({ count: 6, dataQuality: "provisional" }).map(
    (trade, index) => ({ ...trade, id: `p-${index}` }),
  );
  const validation = calculateStrategyValidationSummary(
    CONTINUATION_CALL_V1,
    [...usable, ...provisional],
  );

  assert.equal(validation.usableClosedTrades, 94);
  assert.equal(validation.dataCompleteness, 0.94);
  assert.equal(
    validation.gates.find((gate) => gate.key === "data_completeness")?.passed,
    false,
  );
});
