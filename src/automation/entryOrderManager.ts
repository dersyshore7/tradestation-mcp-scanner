import type { TradeDirection } from "../journal/types.js";
import { createOpenAiClient } from "../openai/client.js";

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
const MAX_REPRICE_ATTEMPTS = 3;
const MAX_ORIGINAL_LIMIT_WORSENING = 1.25;
const MAX_WORKING_LIMIT_WORSENING = 1.35;
const MAX_SPREAD_TO_MID_RATIO = 0.2;
const MIN_REPRICED_REWARD_RISK_R = 1.5;

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Entry order manager did not return a JSON object.");
  }

  return text.slice(start, end + 1);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeDecision(payload: unknown): AiEntryOrderDecision {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Entry order manager returned a non-object decision.");
  }

  const objectPayload = payload as Record<string, unknown>;
  const action = objectPayload.action;
  const confidence = objectPayload.confidence;
  const thesis = typeof objectPayload.thesis === "string" ? objectPayload.thesis.trim() : "";
  const note = typeof objectPayload.note === "string" ? objectPayload.note.trim() : "";
  const plainEnglishExplanation = typeof objectPayload.plainEnglishExplanation === "string"
    ? objectPayload.plainEnglishExplanation.trim()
    : "";

  if (action !== "wait" && action !== "replace_limit" && action !== "cancel_remaining") {
    throw new Error("Entry order manager returned an invalid action.");
  }
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    throw new Error("Entry order manager returned an invalid confidence.");
  }
  if (!thesis || !note) {
    throw new Error("Entry order manager returned an incomplete explanation.");
  }

  return {
    action,
    newLimitPrice: asFiniteNumber(objectPayload.newLimitPrice),
    confidence,
    thesis,
    note,
    plainEnglishExplanation: plainEnglishExplanation || thesis,
  };
}

function buildPrompt(input: EntryOrderManagementContext): string {
  return [
    "You are managing a working buy-to-open options limit order for a paper-trading automation.",
    "Decide whether to wait, replace the remaining limit order, or cancel the unfilled remainder.",
    "The response must be JSON only.",
    "Allowed actions:",
    '- "wait": keep the current working limit order unchanged.',
    '- "replace_limit": cancel/replace the unfilled remainder with a new buy-to-open limit.',
    '- "cancel_remaining": cancel the unfilled remainder and manage only the filled position.',
    "Important constraints:",
    "- Do not chase just because price moved. Replace only when the updated option price is still worth the plan.",
    "- Prefer wait when the thesis is intact and the desired entry may reasonably come back.",
    "- Prefer cancel_remaining when the partial fill is enough exposure or the remaining order no longer has acceptable reward/risk.",
    "- If choosing replace_limit, provide newLimitPrice.",
    "Return JSON with exactly these keys:",
    '{ "action": "wait|replace_limit|cancel_remaining", "newLimitPrice": number|null, "confidence": "low|medium|high", "thesis": "short thesis", "note": "one concise execution note", "plainEnglishExplanation": "plain-English explanation" }',
    "",
    `Working entry context: ${JSON.stringify(input)}`,
  ].join("\n");
}

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

export async function decideAiEntryOrderAction(
  input: EntryOrderManagementContext,
): Promise<AiEntryOrderDecision> {
  const client = await createOpenAiClient();
  const response = await (client as any).responses.create({
    model: "gpt-4.1-mini",
    input: buildPrompt(input),
  });
  const outputText = typeof response?.output_text === "string"
    ? response.output_text.trim()
    : "";
  if (!outputText) {
    throw new Error("Entry order manager returned no text.");
  }

  return normalizeDecision(JSON.parse(extractJsonObject(outputText)));
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

export function evaluateEntryOrderManagementDecision(
  context: EntryOrderManagementContext,
  decision: AiEntryOrderDecision,
  normalizedNewLimitPrice: number | null,
): EntryOrderPolicyResult {
  if (decision.action === "wait") {
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
