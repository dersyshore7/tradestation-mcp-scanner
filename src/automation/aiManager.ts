import { createOpenAiClient } from "../openai/client.js";
import type { TradeDirection } from "../journal/types.js";

export type ThesisStatus = "intact" | "wounded" | "dead";

export type AiManagementDecision = {
  action: "hold" | "update_levels" | "exit_now" | "scale_out";
  updatedStopUnderlying: number | null;
  updatedTargetUnderlying: number | null;
  confidence: "low" | "medium" | "high";
  confidencePercent: number;
  profitChancePercent: number | null;
  thesisStatus: ThesisStatus;
  thesisInvalidationReasons: string[];
  thesis: string;
  note: string;
  plainEnglishExplanation: string;
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
  currentChartReviewSummary?: string | null;
  lastManagementNote: string | null;
  lastManagementThesis: string | null;
  managementHistorySummary: string | null;
  policyFeedbackSummary: string | null;
  trainedPolicySummary: string | null;
  trainedPolicyRecommendedAction: "hold" | "update_levels" | "exit_now" | "scale_out" | null;
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

function clampPercent(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return Math.max(0, Math.min(100, Number(value.toFixed(0))));
}

function fallbackConfidencePercent(confidence: AiManagementDecision["confidence"]): number {
  if (confidence === "high") {
    return 85;
  }
  if (confidence === "medium") {
    return 65;
  }
  return 45;
}

function readThesisStatus(value: unknown): ThesisStatus {
  return value === "wounded" || value === "dead" ? value : "intact";
}

function readThesisInvalidationReasons(value: unknown): string[] {
  const rawReasons = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? [value]
      : [];
  const reasons: string[] = [];

  for (const rawReason of rawReasons) {
    if (typeof rawReason !== "string") {
      continue;
    }
    const reason = rawReason.trim();
    if (reason.length === 0 || reasons.includes(reason)) {
      continue;
    }
    reasons.push(reason);
    if (reasons.length >= 5) {
      break;
    }
  }

  return reasons;
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
  const plainEnglishExplanation = typeof objectPayload.plainEnglishExplanation === "string"
    ? objectPayload.plainEnglishExplanation.trim()
    : "";

  if (action !== "hold" && action !== "update_levels" && action !== "exit_now" && action !== "scale_out") {
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
    confidencePercent:
      clampPercent(asFiniteNumber(objectPayload.confidencePercent))
      ?? fallbackConfidencePercent(confidence),
    profitChancePercent: clampPercent(asFiniteNumber(objectPayload.profitChancePercent)),
    thesisStatus: readThesisStatus(objectPayload.thesisStatus),
    thesisInvalidationReasons: readThesisInvalidationReasons(objectPayload.thesisInvalidationReasons),
    thesis,
    note,
    plainEnglishExplanation: plainEnglishExplanation || thesis,
  };
}

export function normalizeAiManagementDecisionForTest(payload: unknown): AiManagementDecision {
  return normalizeDecision(payload);
}

function roundPrice(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}

function normalizeProtectiveLevels(
  direction: TradeDirection,
  currentStopUnderlying: number | null,
  currentUnderlyingPrice: number | null,
  decision: AiManagementDecision,
): Pick<AiManagementDecision, "updatedStopUnderlying" | "updatedTargetUnderlying"> {
  let updatedStopUnderlying = roundPrice(decision.updatedStopUnderlying);
  let updatedTargetUnderlying = roundPrice(decision.updatedTargetUnderlying);

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

  return { updatedStopUnderlying, updatedTargetUnderlying };
}

function hasThesisDeadEvidence(decision: AiManagementDecision): boolean {
  return decision.thesisStatus === "dead" && decision.thesisInvalidationReasons.length >= 2;
}

function buildInsufficientExitEvidenceNote(decision: AiManagementDecision): string {
  const status = decision.thesisStatus;
  const reasonCount = decision.thesisInvalidationReasons.length;
  return [
    decision.note,
    `AI exit_now was ignored because thesis-dead evidence was insufficient (status=${status}, invalidation_reasons=${reasonCount}; need dead plus at least 2 reasons).`,
  ].join(" ");
}

function buildPrompt(input: AiManagementInput): string {
  return [
    "You are managing a single open options trade for a paper-trading automation.",
    "Decide whether to hold, tighten management levels, or exit now.",
    "The response must be JSON only.",
    "You may choose one of these actions:",
    '- "hold": keep the trade open with unchanged management levels.',
    '- "update_levels": tighten the active stop and/or update the active target.',
    '- "scale_out": take partial profit on a multi-contract winner and tighten protection on the runner.',
    '- "exit_now": close the trade immediately.',
    "Important constraints:",
    "- Do not loosen risk after entry.",
    "- For CALL trades, any new stop must be greater than or equal to the current stop.",
    "- For PUT trades, any new stop must be less than or equal to the current stop.",
    "- Prefer hold over unnecessary changes.",
    '- Use thesisStatus "intact" when the original setup still has a reasonable recovery path.',
    '- Use thesisStatus "wounded" when the setup is damaged but not invalidated; prefer update_levels or hold.',
    '- Use thesisStatus "dead" only when concrete chart/option evidence shows the original setup failed.',
    "- Do not call a normal red pullback or ordinary consolidation a dead thesis.",
    "- For thesisStatus dead, include at least two specific thesisInvalidationReasons from concrete evidence: trade-direction chart alignment flipped or failed, key support/resistance/invalidation area failed, continuation or volume structure broke, chart R:R/recovery chance collapsed, or DTE/time decay makes recovery unlikely.",
    "- Use exit_now for thesis invalidation only when thesisStatus is dead and you can provide at least two concrete invalidation reasons.",
    "- Existing hard exits such as stop hit, target hit, or time exit are handled outside this AI response.",
    "Return JSON with exactly these keys:",
    '{ "action": "hold|update_levels|scale_out|exit_now", "updatedStopUnderlying": number|null, "updatedTargetUnderlying": number|null, "confidence": "low|medium|high", "confidencePercent": number, "profitChancePercent": number|null, "thesisStatus": "intact|wounded|dead", "thesisInvalidationReasons": ["reason"], "thesis": "short explanation", "note": "one concise execution note", "plainEnglishExplanation": "plain-English explanation" }',
    "confidencePercent is your confidence in the management decision, not a guarantee of market outcome.",
    "profitChancePercent is a rough decision-support estimate that the open option can recover to profit before expiration; use null if the option/current chart data is too incomplete.",
    "plainEnglishExplanation must sound like a skilled trader teaching a newer trader in 4-7 clear sentences. Mention the relevant support/resistance, invalidation/target levels, multi-timeframe alignment, volume/continuation quality when available, thesisStatus, and why the action was chosen. Avoid scanner jargon unless you translate it.",
    "",
    input.policyFeedbackSummary
      ? `Rewarded experience memory:\n${input.policyFeedbackSummary}`
      : "Rewarded experience memory: none yet.",
    "",
    input.trainedPolicySummary
      ? `Trained policy prior:\n${input.trainedPolicySummary}`
      : "Trained policy prior: not enough closed paper-trade data yet.",
    "",
    input.trainedPolicyRecommendedAction
      ? `If the live state agrees, the current trained-policy recommendation is: ${input.trainedPolicyRecommendedAction}.`
      : "No confident trained-policy action recommendation is available yet.",
    "",
    input.managementHistorySummary
      ? `Current trade management history:\n${input.managementHistorySummary}`
      : "Current trade management history: none yet.",
    "",
    input.currentChartReviewSummary
      ? `Fresh read-only multi-timeframe chart review:\n${input.currentChartReviewSummary}`
      : "Fresh read-only multi-timeframe chart review: unavailable.",
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
  const { updatedStopUnderlying, updatedTargetUnderlying } = normalizeProtectiveLevels(
    direction,
    currentStopUnderlying,
    currentUnderlyingPrice,
    decision,
  );

  if (decision.action === "exit_now") {
    if (hasThesisDeadEvidence(decision)) {
      return {
        ...decision,
        updatedStopUnderlying: null,
        updatedTargetUnderlying: null,
      };
    }

    if (updatedStopUnderlying !== null) {
      return {
        ...decision,
        action: "update_levels",
        updatedStopUnderlying,
        updatedTargetUnderlying,
        note: `${buildInsufficientExitEvidenceNote(decision)} Tightened risk instead.`,
      };
    }

    return {
      ...decision,
      action: "hold",
      updatedStopUnderlying: null,
      updatedTargetUnderlying: null,
      note: `${buildInsufficientExitEvidenceNote(decision)} Held instead.`,
    };
  }

  if (decision.action === "update_levels" || decision.action === "scale_out") {
    if (decision.action === "update_levels" && updatedStopUnderlying === null && updatedTargetUnderlying === null) {
      return {
        ...decision,
        action: "hold",
        note: `${decision.note} AI update was ignored because it would loosen risk or produced unusable levels.`,
      };
    }

    return {
      ...decision,
      updatedStopUnderlying,
      updatedTargetUnderlying,
    };
  }

  return {
    ...decision,
    updatedStopUnderlying: null,
    updatedTargetUnderlying: null,
  };
}
