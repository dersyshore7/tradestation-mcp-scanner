import type { TradeDirection } from "../journal/types.js";
import { buildMidpointLimitCap } from "./entryPricing.js";

export type EntryOrderManagementAction = "wait" | "replace_limit" | "cancel_remaining";
export type EntryOrderManagementConfidence = "low" | "medium" | "high";

export type AiEntryOrderDecision = {
  action: EntryOrderManagementAction;
  newLimitPrice: number | null;
  confidence: EntryOrderManagementConfidence;
  thesis: string;
  note: string;
  plainEnglishExplanation: string;
};

export type EntryOrderManagementContext = {
  symbol: string;
  direction: TradeDirection;
  optionSymbol: string;
  orderId: string;
  orderAgeSeconds: number | null;
  filledQuantity: number;
  remainingQuantity: number;
  originalLimitPrice: number;
  workingLimitPrice: number;
  averageFillPrice: number | null;
  optionBid: number | null;
  optionAsk: number | null;
  optionMid: number | null;
  underlyingLast: number | null;
  intendedStopUnderlying: number | null;
  intendedTargetUnderlying: number | null;
  plannedRewardRiskR: number | null;
  accountValueUsd: number | null;
  entryBuyingPowerUsd: number | null;
  maxPositionPct: number;
  repriceAttempts: number;
  lastRepriceAt: string | null;
  entryThesis: string | null;
  nowIso: string;
};

export type EntryOrderPolicyResult = {
  allowed: boolean;
  action: EntryOrderManagementAction;
  limitPrice: number | null;
  reason: string;
  estimatedRewardRiskR: number | null;
};

const MIN_REPRICE_ORDER_AGE_SECONDS = 90;
const MIN_REPRICE_COOLDOWN_MS = 2 * 60 * 1000;
const MAX_REPRICE_ATTEMPTS = 1;
const MAX_ORIGINAL_LIMIT_WORSENING = 1.25;
const MAX_WORKING_LIMIT_WORSENING = 1.35;
const MAX_SPREAD_TO_MID_RATIO = 0.2;
const MIN_REPRICED_REWARD_RISK_R = 1.5;
const STALE_ENTRY_CANCEL_MIN_AGE_SECONDS = 5 * 60;

export function buildEntryOrderWaitDecision(reason: string): AiEntryOrderDecision {
  return {
    action: "wait",
    newLimitPrice: null,
    confidence: "low",
    thesis: reason,
    note: reason,
    plainEnglishExplanation: reason,
  };
}

function estimateRepricedRewardRiskR(
  plannedRewardRiskR: number | null,
  originalLimitPrice: number,
  newLimitPrice: number,
): number | null {
  if (plannedRewardRiskR === null || plannedRewardRiskR <= 0) {
    return null;
  }
  if (newLimitPrice <= originalLimitPrice) {
    return plannedRewardRiskR;
  }
  return Number((plannedRewardRiskR * (originalLimitPrice / newLimitPrice)).toFixed(2));
}

function buildStaleEntryCancelReason(context: EntryOrderManagementContext): string | null {
  if (context.remainingQuantity <= 0) {
    return null;
  }
  if (context.orderAgeSeconds === null || context.orderAgeSeconds < STALE_ENTRY_CANCEL_MIN_AGE_SECONDS) {
    return null;
  }
  const ageMinutes = Math.floor(context.orderAgeSeconds / 60);
  const fillText = context.filledQuantity > 0
    ? `${context.filledQuantity} filled and ${context.remainingQuantity} still working`
    : `${context.remainingQuantity} still unfilled`;
  return `Opening order reached the deterministic ${ageMinutes}-minute deadline with ${fillText}; cancel the unfilled remainder instead of waiting or chasing.`;
}

export function evaluateEntryOrderManagementDecision(
  context: EntryOrderManagementContext,
  decision: AiEntryOrderDecision,
  normalizedNewLimitPrice: number | null,
): EntryOrderPolicyResult {
  if (decision.action === "wait") {
    const staleCancelReason = buildStaleEntryCancelReason(context);
    if (staleCancelReason !== null) {
      return {
        allowed: true,
        action: "cancel_remaining",
        limitPrice: null,
        reason: staleCancelReason,
        estimatedRewardRiskR: null,
      };
    }

    return {
      allowed: true,
      action: "wait",
      limitPrice: null,
      reason: decision.note,
      estimatedRewardRiskR: null,
    };
  }

  if (decision.action === "cancel_remaining") {
    return {
      allowed: true,
      action: "cancel_remaining",
      limitPrice: null,
      reason: decision.note,
      estimatedRewardRiskR: null,
    };
  }

  const newLimitPrice = normalizedNewLimitPrice;
  if (newLimitPrice === null || newLimitPrice <= 0) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: "AI requested a replacement but did not provide a usable limit price.",
      estimatedRewardRiskR: null,
    };
  }

  if (context.orderAgeSeconds !== null && context.orderAgeSeconds < MIN_REPRICE_ORDER_AGE_SECONDS) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: `Opening order is only ${context.orderAgeSeconds.toFixed(0)}s old; minimum age before repricing is ${MIN_REPRICE_ORDER_AGE_SECONDS}s.`,
      estimatedRewardRiskR: null,
    };
  }

  if (context.repriceAttempts >= MAX_REPRICE_ATTEMPTS) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: `Opening order already used ${context.repriceAttempts} replace attempt(s); max is ${MAX_REPRICE_ATTEMPTS}.`,
      estimatedRewardRiskR: null,
    };
  }

  if (context.lastRepriceAt) {
    const lastRepriceMs = Date.parse(context.lastRepriceAt);
    const nowMs = Date.parse(context.nowIso);
    if (
      Number.isFinite(lastRepriceMs)
      && Number.isFinite(nowMs)
      && nowMs - lastRepriceMs < MIN_REPRICE_COOLDOWN_MS
    ) {
      return {
        allowed: false,
        action: "wait",
        limitPrice: null,
        reason: "Opening order was replaced less than 2 minutes ago; waiting for the cooldown.",
        estimatedRewardRiskR: null,
      };
    }
  }

  if (newLimitPrice > context.originalLimitPrice * MAX_ORIGINAL_LIMIT_WORSENING) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: `Replacement limit ${newLimitPrice.toFixed(2)} is more than 25% above original limit ${context.originalLimitPrice.toFixed(2)}.`,
      estimatedRewardRiskR: null,
    };
  }

  if (newLimitPrice > context.workingLimitPrice * MAX_WORKING_LIMIT_WORSENING) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: `Replacement limit ${newLimitPrice.toFixed(2)} is more than 35% above working limit ${context.workingLimitPrice.toFixed(2)}.`,
      estimatedRewardRiskR: null,
    };
  }

  if (context.optionAsk !== null && newLimitPrice > context.optionAsk) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: `Replacement limit ${newLimitPrice.toFixed(2)} is above current ask ${context.optionAsk.toFixed(2)}.`,
      estimatedRewardRiskR: null,
    };
  }

  const isWorsening = newLimitPrice > context.workingLimitPrice;
  if (context.optionMid === null && isWorsening) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: "Replacement would chase a worse price, but current option midpoint is unavailable.",
      estimatedRewardRiskR: null,
    };
  }
  if (context.optionAsk === null && isWorsening) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: "Replacement would chase a worse price, but current option ask is unavailable.",
      estimatedRewardRiskR: null,
    };
  }

  const spreadMid = context.optionMid
    ?? (context.optionBid !== null && context.optionAsk !== null
      ? (context.optionBid + context.optionAsk) / 2
      : null);
  if (
    context.optionBid !== null
    && context.optionAsk !== null
    && spreadMid !== null
    && spreadMid > 0
    && (context.optionAsk - context.optionBid) / spreadMid > MAX_SPREAD_TO_MID_RATIO
    && newLimitPrice > spreadMid
  ) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: `Option spread is wider than 20% of mid and replacement limit ${newLimitPrice.toFixed(2)} is above mid ${spreadMid.toFixed(2)}.`,
      estimatedRewardRiskR: null,
    };
  }

  const midpointLimitCap = buildMidpointLimitCap({
    optionSymbol: context.optionSymbol,
    mid: context.optionMid,
  });
  if (midpointLimitCap !== null && newLimitPrice > midpointLimitCap) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: `Replacement limit ${newLimitPrice.toFixed(2)} is above midpoint cap ${midpointLimitCap.toFixed(2)}.`,
      estimatedRewardRiskR: null,
    };
  }

  const filledCostUsd = context.filledQuantity * (context.averageFillPrice ?? context.originalLimitPrice) * 100;
  const remainingCostUsd = context.remainingQuantity * newLimitPrice * 100;
  if (context.accountValueUsd !== null && context.accountValueUsd > 0) {
    const maxPositionCostUsd = context.accountValueUsd * context.maxPositionPct;
    if (filledCostUsd + remainingCostUsd > maxPositionCostUsd) {
      return {
        allowed: false,
        action: "wait",
        limitPrice: null,
        reason: `Replacement would exceed the ${(context.maxPositionPct * 100).toFixed(0)}% account-value cap.`,
        estimatedRewardRiskR: null,
      };
    }
  }

  if (context.entryBuyingPowerUsd !== null && remainingCostUsd > context.entryBuyingPowerUsd) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: `Replacement would require $${remainingCostUsd.toFixed(2)} buying power for the remaining order, above available $${context.entryBuyingPowerUsd.toFixed(2)}.`,
      estimatedRewardRiskR: null,
    };
  }

  const estimatedRewardRiskR = estimateRepricedRewardRiskR(
    context.plannedRewardRiskR,
    context.originalLimitPrice,
    newLimitPrice,
  );
  if (isWorsening && estimatedRewardRiskR === null) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: "Replacement would chase a worse price, but planned reward/risk could not be recalculated.",
      estimatedRewardRiskR,
    };
  }

  if (estimatedRewardRiskR !== null && estimatedRewardRiskR < MIN_REPRICED_REWARD_RISK_R) {
    return {
      allowed: false,
      action: "wait",
      limitPrice: null,
      reason: `Replacement would reduce estimated reward/risk to ${estimatedRewardRiskR.toFixed(2)}R, below 1.50R.`,
      estimatedRewardRiskR,
    };
  }

  return {
    allowed: true,
    action: "replace_limit",
    limitPrice: newLimitPrice,
    reason: decision.note,
    estimatedRewardRiskR,
  };
}
