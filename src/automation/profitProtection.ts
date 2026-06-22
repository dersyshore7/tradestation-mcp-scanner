import type { TradeDirection } from "../journal/types.js";

export type ProfitProtectionState = {
  triggeredAt?: string | null;
  scaledOutAt?: string | null;
  scaledOutQuantity?: number | null;
  peakOptionReturnPct?: number | null;
  peakProgressToTargetPct?: number | null;
  peakOptionMid?: number | null;
  peakUnderlyingPrice?: number | null;
  givebackFromPeakPct?: number | null;
  premiumTrailActivatedAt?: string | null;
  premiumTrailStopOptionMid?: number | null;
  premiumTrailStopReturnPct?: number | null;
  lastCheckedAt?: string | null;
};

export type ProfitProtectionDecision = {
  action: "none" | "scale_out" | "exit_full";
  reason: string | null;
  scaleQuantity: number;
  remainingQuantity: number;
  updatedStopUnderlying: number | null;
  state: ProfitProtectionState;
  diagnostics: {
    triggered: boolean;
    protectionEligible: boolean;
    optionReturnPct: number | null;
    progressToTargetPct: number | null;
    peakOptionReturnPct: number | null;
    peakProgressToTargetPct: number | null;
    givebackFromPeakPct: number | null;
    premiumTrailActive: boolean;
    premiumTrailStopOptionMid: number | null;
    premiumTrailStopReturnPct: number | null;
    premiumTrailBreached: boolean;
  };
};

const OPTION_RETURN_PROTECT_PCT = 20;
const PROGRESS_PROTECT_PCT = 40;
const PROGRESS_OPTION_RETURN_PROTECT_PCT = 10;
const PREMIUM_TRAIL_LOCK_RETURN_PCT = 15;
const PREMIUM_TRAIL_PEAK_MULTIPLE = 0.9;

function roundPrice(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}

function roundPct(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(1));
}

function maxNullable(left: number | null | undefined, right: number | null | undefined): number | null {
  const leftValue = typeof left === "number" && Number.isFinite(left) ? left : null;
  const rightValue = typeof right === "number" && Number.isFinite(right) ? right : null;
  if (leftValue === null) {
    return rightValue;
  }
  if (rightValue === null) {
    return leftValue;
  }
  return Math.max(leftValue, rightValue);
}

function isProfitProtectionTriggered(input: {
  optionReturnPct: number | null;
  progressToTargetPct: number | null;
}): boolean {
  if (input.optionReturnPct !== null && input.optionReturnPct >= OPTION_RETURN_PROTECT_PCT) {
    return true;
  }

  return (
    input.optionReturnPct !== null
    && input.progressToTargetPct !== null
    && input.progressToTargetPct >= PROGRESS_PROTECT_PCT
    && input.optionReturnPct >= PROGRESS_OPTION_RETURN_PROTECT_PCT
  );
}

function buildTriggerReason(input: {
  optionReturnPct: number | null;
  progressToTargetPct: number | null;
}): string {
  if (input.optionReturnPct !== null && input.optionReturnPct >= OPTION_RETURN_PROTECT_PCT) {
    return `Option return reached ${input.optionReturnPct.toFixed(1)}%, at/above the ${OPTION_RETURN_PROTECT_PCT}% profit-protection trigger.`;
  }

  return `Trade reached ${input.progressToTargetPct?.toFixed(1) ?? "n/a"}% of target with option return ${input.optionReturnPct?.toFixed(1) ?? "n/a"}%, meeting the progress profit-protection trigger.`;
}

function computeOptionReturnPct(input: {
  entryOptionPrice: number | null;
  optionMid: number | null;
}): number | null {
  if (
    input.entryOptionPrice === null
    || input.entryOptionPrice <= 0
    || input.optionMid === null
  ) {
    return null;
  }

  return ((input.optionMid - input.entryOptionPrice) / input.entryOptionPrice) * 100;
}

function buildPremiumTrailExitReason(input: {
  currentOptionMid: number;
  stopOptionMid: number;
  peakOptionMid: number | null;
}): string {
  const peakText = input.peakOptionMid !== null
    ? input.peakOptionMid.toFixed(2)
    : "n/a";
  return `Option premium trailing floor hit: current mid ${input.currentOptionMid.toFixed(2)} <= protected floor ${input.stopOptionMid.toFixed(2)} after peak ${peakText}.`;
}

function computeProtectedStopUnderlying(input: {
  direction: TradeDirection;
  currentStopUnderlying: number | null;
  entryUnderlyingPrice: number | null;
  currentUnderlyingPrice: number | null;
}): number | null {
  const { direction, currentStopUnderlying, entryUnderlyingPrice, currentUnderlyingPrice } = input;
  if (entryUnderlyingPrice === null || currentUnderlyingPrice === null) {
    return currentStopUnderlying;
  }

  if (direction === "CALL") {
    if (currentUnderlyingPrice <= entryUnderlyingPrice) {
      return currentStopUnderlying;
    }
    return roundPrice(maxNullable(currentStopUnderlying, entryUnderlyingPrice));
  }

  if (currentUnderlyingPrice >= entryUnderlyingPrice) {
    return currentStopUnderlying;
  }

  if (currentStopUnderlying === null) {
    return roundPrice(entryUnderlyingPrice);
  }
  return roundPrice(Math.min(currentStopUnderlying, entryUnderlyingPrice));
}

export function calculateScaleOutQuantity(quantity: number): {
  scaleQuantity: number;
  remainingQuantity: number;
} {
  const wholeQuantity = Math.max(0, Math.floor(quantity));
  if (wholeQuantity <= 1) {
    return {
      scaleQuantity: wholeQuantity,
      remainingQuantity: 0,
    };
  }

  const scaleQuantity = Math.min(Math.ceil(wholeQuantity * 0.5), wholeQuantity - 1);
  return {
    scaleQuantity,
    remainingQuantity: wholeQuantity - scaleQuantity,
  };
}

export function decideProfitProtection(input: {
  direction: TradeDirection;
  quantity: number;
  entryOptionPrice: number | null;
  optionReturnPct: number | null;
  progressToTargetPct: number | null;
  currentState?: ProfitProtectionState | null;
  currentStopUnderlying: number | null;
  entryUnderlyingPrice: number | null;
  currentUnderlyingPrice: number | null;
  currentOptionMid: number | null;
  nowIso: string;
}): ProfitProtectionDecision {
  const priorState = input.currentState ?? {};
  const peakOptionReturnPct = roundPct(maxNullable(priorState.peakOptionReturnPct, input.optionReturnPct));
  const peakProgressToTargetPct = roundPct(maxNullable(priorState.peakProgressToTargetPct, input.progressToTargetPct));
  const peakOptionMid = roundPrice(maxNullable(priorState.peakOptionMid, input.currentOptionMid));
  const givebackFromPeakPct =
    peakOptionReturnPct !== null && input.optionReturnPct !== null
      ? roundPct(peakOptionReturnPct - input.optionReturnPct)
      : priorState.givebackFromPeakPct ?? null;
  const triggered = isProfitProtectionTriggered(input);
  const protectionEligible = triggered || Boolean(priorState.triggeredAt);
  const premiumTrailActive = Boolean(priorState.premiumTrailActivatedAt) || (
    input.entryOptionPrice !== null
    && input.entryOptionPrice > 0
    && input.currentOptionMid !== null
    && input.optionReturnPct !== null
    && input.optionReturnPct >= OPTION_RETURN_PROTECT_PCT
  );
  const premiumTrailLockFloor = premiumTrailActive && input.entryOptionPrice !== null && input.entryOptionPrice > 0
    ? input.entryOptionPrice * (1 + (PREMIUM_TRAIL_LOCK_RETURN_PCT / 100))
    : null;
  const premiumTrailPeakFloor = premiumTrailActive && input.currentOptionMid !== null
    ? input.currentOptionMid * PREMIUM_TRAIL_PEAK_MULTIPLE
    : null;
  const premiumTrailStopOptionMid = premiumTrailActive
    ? roundPrice(maxNullable(
        priorState.premiumTrailStopOptionMid,
        maxNullable(premiumTrailLockFloor, premiumTrailPeakFloor),
      ))
    : priorState.premiumTrailStopOptionMid ?? null;
  const premiumTrailStopReturnPct = premiumTrailStopOptionMid !== null
    ? roundPct(computeOptionReturnPct({
        entryOptionPrice: input.entryOptionPrice,
        optionMid: premiumTrailStopOptionMid,
      }))
    : priorState.premiumTrailStopReturnPct ?? null;
  const premiumTrailBreached =
    premiumTrailActive
    && premiumTrailStopOptionMid !== null
    && input.currentOptionMid !== null
    && input.currentOptionMid <= premiumTrailStopOptionMid;
  const state: ProfitProtectionState = {
    ...priorState,
    peakOptionReturnPct,
    peakProgressToTargetPct,
    peakOptionMid,
    peakUnderlyingPrice:
      input.progressToTargetPct !== null && input.progressToTargetPct === peakProgressToTargetPct
        ? input.currentUnderlyingPrice
        : priorState.peakUnderlyingPrice ?? input.currentUnderlyingPrice,
    givebackFromPeakPct,
    ...(premiumTrailActive
      ? {
          premiumTrailActivatedAt: priorState.premiumTrailActivatedAt ?? input.nowIso,
          premiumTrailStopOptionMid,
          premiumTrailStopReturnPct,
        }
      : {}),
    lastCheckedAt: input.nowIso,
    ...(triggered && !priorState.triggeredAt ? { triggeredAt: input.nowIso } : {}),
  };

  const diagnostics = {
    triggered,
    protectionEligible,
    optionReturnPct: input.optionReturnPct,
    progressToTargetPct: input.progressToTargetPct,
    peakOptionReturnPct,
    peakProgressToTargetPct,
    givebackFromPeakPct,
    premiumTrailActive,
    premiumTrailStopOptionMid,
    premiumTrailStopReturnPct,
    premiumTrailBreached,
  };
  const updatedStopUnderlying = protectionEligible
    ? computeProtectedStopUnderlying(input)
    : null;

  if (
    premiumTrailBreached
    && input.currentOptionMid !== null
    && premiumTrailStopOptionMid !== null
  ) {
    return {
      action: "exit_full",
      reason: buildPremiumTrailExitReason({
        currentOptionMid: input.currentOptionMid,
        stopOptionMid: premiumTrailStopOptionMid,
        peakOptionMid,
      }),
      scaleQuantity: Math.max(0, Math.floor(input.quantity)),
      remainingQuantity: 0,
      updatedStopUnderlying,
      state,
      diagnostics,
    };
  }

  if (!triggered || priorState.scaledOutAt) {
    return {
      action: "none",
      reason: premiumTrailActive
        ? `Premium trailing floor active at ${premiumTrailStopOptionMid?.toFixed(2) ?? "n/a"} (${premiumTrailStopReturnPct?.toFixed(1) ?? "n/a"}% option return).`
        : null,
      scaleQuantity: 0,
      remainingQuantity: Math.max(0, Math.floor(input.quantity)),
      updatedStopUnderlying,
      state,
      diagnostics,
    };
  }

  const { scaleQuantity, remainingQuantity } = calculateScaleOutQuantity(input.quantity);
  const reason = premiumTrailActive
    ? `${buildTriggerReason(input)} Premium trailing floor active at ${premiumTrailStopOptionMid?.toFixed(2) ?? "n/a"} (${premiumTrailStopReturnPct?.toFixed(1) ?? "n/a"}% option return).`
    : buildTriggerReason(input);

  if (input.quantity <= 1) {
    return {
      action: "none",
      reason,
      scaleQuantity: 0,
      remainingQuantity: Math.max(0, Math.floor(input.quantity)),
      updatedStopUnderlying,
      state,
      diagnostics,
    };
  }

  return {
    action: "scale_out",
    reason,
    scaleQuantity,
    remainingQuantity,
    updatedStopUnderlying,
    state,
    diagnostics,
  };
}
