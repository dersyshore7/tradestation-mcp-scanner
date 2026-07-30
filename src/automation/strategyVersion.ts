import type { TradeDirection } from "../journal/types.js";

export const LEGACY_STRATEGY_VERSION = "legacy_unversioned";
export const CONTINUATION_CALL_V1 = "continuation_call_v1";
export const CONTINUATION_PUT_V1 = "continuation_put_v1";
export const SUPPORT_RESISTANCE_V1 = "support_resistance_v1";

export type StrategyVersionId =
  | typeof LEGACY_STRATEGY_VERSION
  | typeof CONTINUATION_CALL_V1
  | typeof CONTINUATION_PUT_V1
  | typeof SUPPORT_RESISTANCE_V1
  | (string & {});

export type StrategyLifecycleStatus =
  | "shadow"
  | "promoted"
  | "halted"
  | "retired";

export function strategyVersionForDirection(direction: TradeDirection): StrategyVersionId {
  return direction === "CALL" ? CONTINUATION_CALL_V1 : CONTINUATION_PUT_V1;
}

export function directionForStrategyVersion(
  version: StrategyVersionId,
): TradeDirection | null {
  if (version === CONTINUATION_CALL_V1) {
    return "CALL";
  }
  if (version === CONTINUATION_PUT_V1) {
    return "PUT";
  }
  return null;
}
