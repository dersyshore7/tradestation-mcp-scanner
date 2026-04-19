import { createOpenAiClient } from "../openai/client.js";
import type { TradeDirection } from "../journal/types.js";

export type AiManagementDecision = {
  action: "hold" | "update_levels" | "exit_now";
  updatedStopUnderlying: number | null;
  updatedTargetUnderlying: number | null;
  confidence: "low" | "medium" | "high";
  thesis: string;
  note: string;
};

export type AiManagementInput = {
  symbol: string;
  direction: TradeDirection;
  setupType: string;
  confidenceBucket: string | null;
  entryDate: string;
  expirationDate: string | null;
  dteAtEntry: number | null;
  underlyingEntryPrice: number | null;
  optionEntryPrice: number | null;
  currentUnderlyingPrice: number | null;
  currentOptionMid: number | null;
  currentStopUnderlying: number | null;
  currentTargetUnderlying: number | null;
  originalStopUnderlying: number | null;
  originalTargetUnderlying: number | null;
  timeExitDate: string | null;
  progressToTargetPct: number | null;
  optionReturnPct: number | null;
  rationale: string | null;
  lastManagementNote: string | null;
  lastManagementThesis: string | null;
  managementHistorySummary: string | null;
  policyFeedbackSummary: string | null;
};

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI manager did not return a JSON object.");
  }

  return text.slice(start, end + 1);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeDecision(payload: unknown): AiManagementDecision {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("AI manager returned a non-object decision.");
  }

  const objectPayload = payload as Record<string, unknown>;
  const action = objectPayload.action;
  const confidence = objectPayload.confidence;
  const thesis = typeof objectPayload.thesis === "string" ? objectPayload.thesis.trim() : "";
  const note = typeof objectPayload.note === "string" ? objectPayload.note.trim() : "";

  if (action !== "hold" && action !== "update_levels" && action !== "exit_now") {
    throw new Error("AI manager returned an invalid action.");
  }
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    throw new Error("AI manager returned an invalid confidence.");
  }
  if (!thesis || !note) {
    throw new Error("AI manager returned an incomplete explanation.");
  }

  return {
    action,
    updatedStopUnderlying: asFiniteNumber(objectPayload.updatedStopUnderlying),
    updatedTargetUnderlying: asFiniteNumber(objectPayload.updatedTargetUnderlying),
    confidence,
    thesis,
    note,
  };
}

function roundPrice(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}

function buildPrompt(input: AiManagementInput): string {
  return [
    "You are managing a single open options trade for a paper-trading automation.",
    "Decide whether to hold, tighten management levels, or exit now.",
    "The response must be JSON only.",
    "You may choose one of these actions:",
    '- "hold": keep the trade open with unchanged management levels.',
    '- "update_levels": tighten the active stop and/or update the active target.',
    '- "exit_now": close the trade immediately.',
    "Important constraints:",
    "- Do not loosen risk after entry.",
    "- For CALL trades, any new stop must be greater than or equal to the current stop.",
    "- For PUT trades, any new stop must be less than or equal to the current stop.",
    "- Prefer hold over unnecessary changes.",
    "- Use exit_now if the thesis is degrading, the trade is extended, or protecting gains is better than holding.",
    "Return JSON with exactly these keys:",
    '{ "action": "hold|update_levels|exit_now", "updatedStopUnderlying": number|null, "updatedTargetUnderlying": number|null, "confidence": "low|medium|high", "thesis": "short explanation", "note": "one concise execution note" }',
    "",
    input.policyFeedbackSummary
      ? `Rewarded experience memory:\n${input.policyFeedbackSummary}`
      : "Rewarded experience memory: none yet.",
    "",
    input.managementHistorySummary
      ? `Current trade management history:\n${input.managementHistorySummary}`
      : "Current trade management history: none yet.",
    "",
    `Trade context: ${JSON.stringify(input)}`,
  ].join("\n");
}

export async function decideAiManagementAction(
  input: AiManagementInput,
): Promise<AiManagementDecision> {
  const client = await createOpenAiClient();
  const response = await (client as any).responses.create({
    model: "gpt-4.1-mini",
    input: buildPrompt(input),
  });
  const outputText = typeof response?.output_text === "string"
    ? response.output_text.trim()
    : "";
  if (!outputText) {
    throw new Error("AI manager returned no text.");
  }

  return normalizeDecision(JSON.parse(extractJsonObject(outputText)));
}

export function enforceAiManagementGuardrails(
  direction: TradeDirection,
  currentStopUnderlying: number | null,
  currentTargetUnderlying: number | null,
  currentUnderlyingPrice: number | null,
  decision: AiManagementDecision,
): AiManagementDecision {
  let updatedStopUnderlying = roundPrice(decision.updatedStopUnderlying);
  let updatedTargetUnderlying = roundPrice(decision.updatedTargetUnderlying);

  if (decision.action === "update_levels") {
    if (direction === "CALL") {
      if (
        updatedStopUnderlying !== null
        && (
          (currentStopUnderlying !== null && updatedStopUnderlying < currentStopUnderlying)
          || (currentUnderlyingPrice !== null && updatedStopUnderlying >= currentUnderlyingPrice)
        )
      ) {
        updatedStopUnderlying = null;
      }
      if (
        updatedTargetUnderlying !== null
        && currentUnderlyingPrice !== null
        && updatedTargetUnderlying <= currentUnderlyingPrice
      ) {
        updatedTargetUnderlying = null;
      }
    } else {
      if (
        updatedStopUnderlying !== null
        && (
          (currentStopUnderlying !== null && updatedStopUnderlying > currentStopUnderlying)
          || (currentUnderlyingPrice !== null && updatedStopUnderlying <= currentUnderlyingPrice)
        )
      ) {
        updatedStopUnderlying = null;
      }
      if (
        updatedTargetUnderlying !== null
        && currentUnderlyingPrice !== null
        && updatedTargetUnderlying >= currentUnderlyingPrice
      ) {
        updatedTargetUnderlying = null;
      }
    }

    if (updatedStopUnderlying === null && updatedTargetUnderlying === null) {
      return {
        ...decision,
        action: "hold",
        note: `${decision.note} AI update was ignored because it would loosen risk or produced unusable levels.`,
      };
    }
  } else {
    updatedStopUnderlying = null;
    updatedTargetUnderlying = null;
  }

  return {
    ...decision,
    updatedStopUnderlying,
    updatedTargetUnderlying,
  };
}
