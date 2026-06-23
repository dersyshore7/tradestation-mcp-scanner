import { createOpenAiClient } from "../openai/client.js";
import { calculateAggregateCloseReviewValues } from "./repository.js";
import type {
  AccountMode,
  JournalExitPriceSource,
  JournalTradeDetail,
  JournalTradeExitRecord,
  TradeDirection,
  TradeStatus,
} from "./types.js";

type NumericValue = number | string | null | undefined;

export type LossPostMortemClassification =
  | "no_program_issue_detected"
  | "program_issue_possible"
  | "data_quality_issue"
  | "presentation_issue";

export type LossPostMortemFlagCategory = "program" | "data" | "presentation";

export type LossPostMortemFlag = {
  code:
    | "aggregate_review_mismatch"
    | "live_exit_not_broker_confirmed"
    | "quantity_mismatch"
    | "winner_giveback_without_protection"
    | "earned_multi_contract_protection_without_scale_out"
    | "protected_stop_reporting_confusion"
    | "multi_exit_latest_exit_can_mislead";
  category: LossPostMortemFlagCategory;
  title: string;
  detail: string;
};

export type LossPostMortemProgramRecommendation = {
  recommended: boolean;
  title: string;
  rationale: string;
};

export type LossTradePostMortem = {
  summary: string;
  classification: LossPostMortemClassification;
  evidence: string[];
  flags: LossPostMortemFlag[];
  program_recommendation: LossPostMortemProgramRecommendation;
};

export type LossPostMortemExitInput = {
  exit_time: string;
  exit_reason: string;
  option_exit_price: NumericValue;
  quantity_closed: number | null;
  fees_usd?: NumericValue;
  slippage_usd?: NumericValue;
  exit_notes?: string | null;
  exit_price_source?: JournalExitPriceSource | null;
  broker_confirmed?: boolean | null;
  broker_repaired?: boolean | null;
  broker_order_id?: string | null;
};

export type LossPostMortemTradeInput = {
  id: string;
  account_mode: AccountMode;
  symbol: string;
  direction: TradeDirection;
  status: TradeStatus;
  contracts: number | null;
  position_cost_usd: NumericValue;
  option_entry_price: NumericValue;
  planned_risk_usd?: NumericValue;
  intended_stop_underlying?: NumericValue;
  intended_target_underlying?: NumericValue;
  signal_snapshot_json?: Record<string, unknown> | null;
  review?: {
    winner?: boolean | null;
    realized_pl_usd?: NumericValue;
    realized_r_multiple?: NumericValue;
    realized_return_pct?: NumericValue;
  } | null;
  exits: LossPostMortemExitInput[];
};

export type LossPostMortemAiReview = {
  narrative: string;
  program_recommendation: LossPostMortemProgramRecommendation;
};

type AutomationSnapshot = {
  quantity: number | null;
  requestedQuantity: number | null;
  filledQuantity: number | null;
  activeStopUnderlying: number | null;
  intendedStopUnderlying: number | null;
  managementHistory: Record<string, unknown>[];
  decisionLog: Record<string, unknown>[];
  profitProtectionState: Record<string, unknown> | null;
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function toRequiredNumericString(value: NumericValue): string {
  const numericValue = asNumber(value);
  return numericValue === null ? "0" : String(numericValue);
}

function toOptionalNumericString(value: NumericValue): string | null {
  const numericValue = asNumber(value);
  return numericValue === null ? null : String(numericValue);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function formatMoney(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(2)}`;
}

function formatPct(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

function formatRatio(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2)}R`;
}

function readAutomationSnapshot(signalSnapshot: Record<string, unknown> | null | undefined): AutomationSnapshot {
  const root = asRecord(signalSnapshot);
  const automation = asRecord(asRecord(root?.automation)?.paperTrader);
  const profitProtectionState = asRecord(automation?.profitProtectionState);

  return {
    quantity: asNumber(automation?.quantity),
    requestedQuantity: asNumber(automation?.requestedQuantity),
    filledQuantity: asNumber(automation?.filledQuantity),
    activeStopUnderlying: asNumber(automation?.activeStopUnderlying),
    intendedStopUnderlying: asNumber(automation?.intendedStopUnderlying),
    managementHistory: asRecordArray(automation?.managementHistory),
    decisionLog: asRecordArray(automation?.decisionLog),
    profitProtectionState,
  };
}

function isMoreProtectiveStop(
  direction: TradeDirection,
  activeStop: number | null,
  intendedStop: number | null,
): boolean {
  if (activeStop === null || intendedStop === null) {
    return false;
  }
  return direction === "CALL" ? activeStop > intendedStop : activeStop < intendedStop;
}

function maxNullable(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function readPeakOptionReturnPct(automation: AutomationSnapshot): number | null {
  return maxNullable([
    asNumber(automation.profitProtectionState?.peakOptionReturnPct),
    ...automation.managementHistory.map((entry) => asNumber(entry.optionReturnPct)),
    ...automation.decisionLog.map((entry) => asNumber(entry.optionReturnPct)),
  ]);
}

function readProtectionEvidence(
  trade: LossPostMortemTradeInput,
  automation: AutomationSnapshot,
): string[] {
  const state = automation.profitProtectionState;
  const evidence: string[] = [];
  if (typeof state?.triggeredAt === "string" && state.triggeredAt) {
    evidence.push(`profit protection triggered at ${state.triggeredAt}`);
  }
  if (typeof state?.premiumTrailActivatedAt === "string" && state.premiumTrailActivatedAt) {
    evidence.push(`premium trail activated at ${state.premiumTrailActivatedAt}`);
  }
  if (typeof state?.scaledOutAt === "string" && state.scaledOutAt) {
    evidence.push(`scale-out recorded at ${state.scaledOutAt}`);
  }
  if (
    automation.managementHistory.some((entry) =>
      entry.stopProtectionEligible === true || entry.stopSource === "earned_protection"
    )
  ) {
    evidence.push("management history marked stop protection as earned");
  }
  if (
    automation.decisionLog.some((entry) =>
      entry.stopProtectionEligible === true || entry.stopSource === "earned_protection"
    )
  ) {
    evidence.push("decision log marked stop protection as earned");
  }
  if (
    isMoreProtectiveStop(
      trade.direction,
      automation.activeStopUnderlying,
      automation.intendedStopUnderlying ?? asNumber(trade.intended_stop_underlying),
    )
  ) {
    evidence.push("active stop is more protective than the original chart stop");
  }
  return evidence;
}

function sortExitsAscending(exits: LossPostMortemExitInput[]): LossPostMortemExitInput[] {
  return [...exits].sort((left, right) => left.exit_time.localeCompare(right.exit_time));
}

function summarizeExitSequence(exits: LossPostMortemExitInput[]): string {
  if (exits.length === 0) {
    return "No exit rows are attached to this closed loser.";
  }
  return sortExitsAscending(exits)
    .map((exit) => {
      const quantity = exit.quantity_closed ?? "n/a";
      const price = formatMoney(asNumber(exit.option_exit_price));
      return `${exit.exit_reason} ${quantity}x at ${price}`;
    })
    .join("; ");
}

function calculateTotalClosedQuantity(exits: LossPostMortemExitInput[]): number {
  return exits.reduce((sum, exit) => sum + Math.max(0, exit.quantity_closed ?? 0), 0);
}

function readExpectedQuantity(trade: LossPostMortemTradeInput, automation: AutomationSnapshot): number | null {
  return automation.filledQuantity
    ?? automation.quantity
    ?? automation.requestedQuantity
    ?? (trade.exits.length <= 1 ? trade.contracts : null);
}

function addFlag(flags: LossPostMortemFlag[], flag: LossPostMortemFlag): void {
  if (!flags.some((existing) => existing.code === flag.code)) {
    flags.push(flag);
  }
}

function buildClassification(flags: LossPostMortemFlag[]): LossPostMortemClassification {
  if (flags.some((flag) => flag.category === "program")) {
    return "program_issue_possible";
  }
  if (flags.some((flag) => flag.category === "data")) {
    return "data_quality_issue";
  }
  if (flags.some((flag) => flag.category === "presentation")) {
    return "presentation_issue";
  }
  return "no_program_issue_detected";
}

function buildProgramRecommendation(
  classification: LossPostMortemClassification,
  flags: LossPostMortemFlag[],
): LossPostMortemProgramRecommendation {
  const firstProgramFlag = flags.find((flag) => flag.category === "program");
  if (firstProgramFlag) {
    return {
      recommended: true,
      title: firstProgramFlag.title,
      rationale: firstProgramFlag.detail,
    };
  }

  const firstDataFlag = flags.find((flag) => flag.category === "data");
  if (firstDataFlag) {
    return {
      recommended: true,
      title: "Repair exit truth before changing strategy",
      rationale: firstDataFlag.detail,
    };
  }

  const firstPresentationFlag = flags.find((flag) => flag.category === "presentation");
  if (firstPresentationFlag) {
    return {
      recommended: true,
      title: "Clarify loss reporting",
      rationale: firstPresentationFlag.detail,
    };
  }

  return {
    recommended: false,
    title: "No program change recommended",
    rationale: classification === "no_program_issue_detected"
      ? "The recorded journal, exit, and management evidence did not show a deterministic program error."
      : "No deterministic implementation change was identified.",
  };
}

function buildSummary(
  trade: LossPostMortemTradeInput,
  classification: LossPostMortemClassification,
  flags: LossPostMortemFlag[],
): string {
  const realizedPl = asNumber(trade.review?.realized_pl_usd);
  if (classification === "program_issue_possible") {
    return `${trade.symbol} closed at ${formatMoney(realizedPl)} and has a possible program issue: ${flags.find((flag) => flag.category === "program")?.title ?? "review the flagged evidence"}.`;
  }
  if (classification === "data_quality_issue") {
    return `${trade.symbol} closed at ${formatMoney(realizedPl)}, but exit-price truth needs cleanup before judging the loss.`;
  }
  if (classification === "presentation_issue") {
    return `${trade.symbol} closed at ${formatMoney(realizedPl)}; the recorded behavior looks explainable, but the dashboard should explain the exit sequence more clearly.`;
  }
  return `${trade.symbol} closed at ${formatMoney(realizedPl)} with no deterministic program error found in the recorded journal evidence.`;
}

export function buildLossPostMortem(trade: LossPostMortemTradeInput): LossTradePostMortem {
  const realizedPl = asNumber(trade.review?.realized_pl_usd);
  const realizedR = asNumber(trade.review?.realized_r_multiple);
  const realizedReturnPct = asNumber(trade.review?.realized_return_pct);
  const exits = trade.exits.filter((exit) => exit.quantity_closed !== null);
  const flags: LossPostMortemFlag[] = [];
  const evidence: string[] = [
    `Realized P/L ${formatMoney(realizedPl)}, ${formatRatio(realizedR)}, return ${formatPct(realizedReturnPct)}.`,
    `Exit sequence: ${summarizeExitSequence(exits)}.`,
  ];

  const totalClosedQuantity = calculateTotalClosedQuantity(exits);
  evidence.push(`Total closed quantity recorded across exits: ${totalClosedQuantity}.`);

  if (exits.length > 0 && realizedPl !== null) {
    const aggregate = calculateAggregateCloseReviewValues({
      contracts: trade.contracts,
      position_cost_usd: toRequiredNumericString(trade.position_cost_usd),
      option_entry_price: toOptionalNumericString(trade.option_entry_price),
      planned_risk_usd: toOptionalNumericString(trade.planned_risk_usd),
    }, exits.map((exit) => ({
      option_exit_price: toRequiredNumericString(exit.option_exit_price),
      quantity_closed: exit.quantity_closed ?? 0,
      fees_usd: toRequiredNumericString(exit.fees_usd),
      slippage_usd: toRequiredNumericString(exit.slippage_usd),
    })));
    const delta = roundMoney(aggregate.realizedPlUsd - realizedPl);
    const mismatchThreshold = Math.max(1, Math.abs(realizedPl) * 0.02);
    evidence.push(`Aggregate exit recalculation gives ${formatMoney(roundMoney(aggregate.realizedPlUsd))} (delta ${formatMoney(delta)}).`);
    if (Math.abs(delta) > mismatchThreshold) {
      addFlag(flags, {
        code: "aggregate_review_mismatch",
        category: "data",
        title: "Review P/L does not match all recorded exits",
        detail: `The journal review shows ${formatMoney(realizedPl)}, but recalculating all exits gives ${formatMoney(roundMoney(aggregate.realizedPlUsd))}. Recompute or repair the review before treating this as a strategy loss.`,
      });
    }
  }

  const automation = readAutomationSnapshot(trade.signal_snapshot_json);
  const expectedQuantity = readExpectedQuantity(trade, automation);
  if (totalClosedQuantity <= 0) {
    addFlag(flags, {
      code: "quantity_mismatch",
      category: "data",
      title: "Closed quantity is missing",
      detail: "The trade is closed as a loser, but the attached exits do not show a positive closed quantity.",
    });
  } else if (
    expectedQuantity !== null
    && Math.abs(expectedQuantity - totalClosedQuantity) > 0.01
  ) {
    addFlag(flags, {
      code: "quantity_mismatch",
      category: "data",
      title: "Closed quantity does not match the recorded held quantity",
      detail: `The automation/journal expected ${expectedQuantity} contract(s), while exits closed ${totalClosedQuantity}. Verify partial fills and entry-order bookkeeping before judging the loss.`,
    });
  }

  if (trade.account_mode === "live") {
    const provisionalExit = exits.find((exit) => exit.exit_price_source === "provisional_quote");
    const unconfirmedExit = exits.find((exit) => exit.broker_confirmed !== true);
    if (provisionalExit || unconfirmedExit) {
      addFlag(flags, {
        code: "live_exit_not_broker_confirmed",
        category: "data",
        title: "Live loss is not fully broker-confirmed",
        detail: provisionalExit
          ? "At least one live exit still uses a provisional quote, so broker fill repair should run before drawing conclusions."
          : "At least one live exit is not marked broker-confirmed, so broker-vs-journal truth should be reconciled first.",
      });
    }
  }

  const peakOptionReturnPct = readPeakOptionReturnPct(automation);
  const protectionEvidence = readProtectionEvidence(trade, automation);
  const hasProtectionEvidence = protectionEvidence.length > 0;
  const hasPartialProfitExit = exits.some((exit) => exit.exit_reason === "partial_profit");
  const latestExit = sortExitsAscending(exits).at(-1) ?? null;
  const expectedOrClosedQuantity = Math.max(expectedQuantity ?? 0, totalClosedQuantity);
  if (peakOptionReturnPct !== null) {
    evidence.push(`Peak option return recorded by management: ${formatPct(peakOptionReturnPct)}.`);
  }
  if (protectionEvidence.length > 0) {
    evidence.push(`Protection evidence: ${protectionEvidence.join("; ")}.`);
  }

  if (realizedPl !== null && realizedPl < 0 && peakOptionReturnPct !== null && peakOptionReturnPct >= 20) {
    if (!hasProtectionEvidence) {
      addFlag(flags, {
        code: "winner_giveback_without_protection",
        category: "program",
        title: "Recorded +20% winner lacked visible profit protection",
        detail: `Management history recorded a ${formatPct(peakOptionReturnPct)} peak option return, but the stored snapshot does not show earned stop protection, premium trail activation, or scale-out state before the trade closed red.`,
      });
    } else if (expectedOrClosedQuantity > 1 && !hasPartialProfitExit && typeof automation.profitProtectionState?.scaledOutAt !== "string") {
      addFlag(flags, {
        code: "earned_multi_contract_protection_without_scale_out",
        category: "program",
        title: "Earned multi-contract protection did not record a scale-out",
        detail: `The trade appears to have had more than one contract and earned protection after a ${formatPct(peakOptionReturnPct)} peak, but no partial-profit exit or scaledOutAt state is recorded.`,
      });
    } else if (latestExit?.exit_reason === "stop_hit") {
      addFlag(flags, {
        code: "protected_stop_reporting_confusion",
        category: "presentation",
        title: "Protected-stop loss needs clearer wording",
        detail: "The trade had evidence of earned protection and later stopped out. The UI should distinguish original stop, active protected stop, peak gain, giveback, and final realized P/L.",
      });
    }
  }

  if (exits.length > 1 && latestExit?.exit_reason === "stop_hit" && hasPartialProfitExit) {
    addFlag(flags, {
      code: "multi_exit_latest_exit_can_mislead",
      category: "presentation",
      title: "Latest exit alone can mislabel the trade",
      detail: "This loss has multiple exits including a partial-profit row, so the post-mortem should use aggregate exit math instead of describing it as a simple stop-out.",
    });
  }

  const classification = buildClassification(flags);
  const programRecommendation = buildProgramRecommendation(classification, flags);

  return {
    summary: buildSummary(trade, classification, flags),
    classification,
    evidence,
    flags,
    program_recommendation: programRecommendation,
  };
}

export function buildLossPostMortemFromJournalTrade(trade: JournalTradeDetail): LossTradePostMortem {
  return buildLossPostMortem({
    id: trade.id,
    account_mode: trade.account_mode,
    symbol: trade.symbol,
    direction: trade.direction,
    status: trade.status,
    contracts: trade.contracts,
    position_cost_usd: trade.position_cost_usd,
    option_entry_price: trade.option_entry_price,
    planned_risk_usd: trade.planned_risk_usd,
    intended_stop_underlying: trade.intended_stop_underlying,
    intended_target_underlying: trade.intended_target_underlying,
    signal_snapshot_json: trade.signal_snapshot_json,
    review: trade.review,
    exits: trade.exits.map((exit: JournalTradeExitRecord) => ({
      exit_time: exit.exit_time,
      exit_reason: exit.exit_reason,
      option_exit_price: exit.option_exit_price,
      quantity_closed: exit.quantity_closed,
      fees_usd: exit.fees_usd,
      slippage_usd: exit.slippage_usd,
      exit_notes: exit.exit_notes,
      exit_price_source: exit.exit_price_source,
      broker_confirmed: exit.broker_confirmed,
      broker_repaired: exit.broker_repaired,
      broker_order_id: exit.broker_order_id,
    })),
  });
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Loss post-mortem AI did not return a JSON object.");
  }
  return text.slice(start, end + 1);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeLossPostMortemAiReviewForTest(
  payload: unknown,
  deterministicPostMortem: LossTradePostMortem,
): LossPostMortemAiReview {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Loss post-mortem AI returned a non-object review.");
  }

  const objectPayload = payload as Record<string, unknown>;
  const narrative = readString(objectPayload.narrative) ?? readString(objectPayload.summary);
  if (!narrative) {
    throw new Error("Loss post-mortem AI returned no narrative.");
  }

  const rawRecommendation = asRecord(objectPayload.program_recommendation)
    ?? asRecord(objectPayload.programRecommendation);
  const aiRecommended = rawRecommendation?.recommended === true;
  const deterministicAllowsRecommendation = deterministicPostMortem.program_recommendation.recommended;
  if (!aiRecommended || !deterministicAllowsRecommendation) {
    return {
      narrative,
      program_recommendation: {
        recommended: false,
        title: "No AI program change recommended",
        rationale: deterministicAllowsRecommendation
          ? "The AI did not recommend a program change beyond the deterministic findings."
          : "Deterministic flags did not support a program change, so AI recommendations are suppressed.",
      },
    };
  }

  return {
    narrative,
    program_recommendation: {
      recommended: true,
      title:
        readString(rawRecommendation?.title)
        ?? deterministicPostMortem.program_recommendation.title,
      rationale:
        readString(rawRecommendation?.rationale)
        ?? deterministicPostMortem.program_recommendation.rationale,
    },
  };
}

function buildAiPrompt(trade: JournalTradeDetail, postMortem: LossTradePostMortem): string {
  return [
    "You are reviewing a closed losing options trade for possible software/program errors.",
    "Do not change or critique the trading strategy. Do not recommend new entry rules, different stop distance, different targets, new risk caps, or order placement behavior.",
    "You may recommend a program/reporting/reconciliation change only if the deterministic post-mortem flags support it.",
    "If deterministic flags do not support a program change, say no program change is recommended.",
    "Use only the supplied JSON facts. Do not infer broker fills or market data that is not present.",
    "Return JSON only with exactly this shape:",
    '{ "narrative": "4-7 plain-English sentences", "program_recommendation": { "recommended": boolean, "title": "short title", "rationale": "why this is or is not recommended" } }',
    "",
    `Trade: ${JSON.stringify({
      id: trade.id,
      symbol: trade.symbol,
      account_mode: trade.account_mode,
      direction: trade.direction,
      entry_date: trade.entry_date,
      entry_time: trade.entry_time,
      contracts: trade.contracts,
      option_entry_price: trade.option_entry_price,
      position_cost_usd: trade.position_cost_usd,
      intended_stop_underlying: trade.intended_stop_underlying,
      intended_target_underlying: trade.intended_target_underlying,
      review: trade.review,
      exits: trade.exits,
    })}`,
    "",
    `Deterministic post-mortem: ${JSON.stringify(postMortem)}`,
  ].join("\n");
}

export async function runLossPostMortemAiReview(
  trade: JournalTradeDetail,
  deterministicPostMortem: LossTradePostMortem,
): Promise<LossPostMortemAiReview> {
  const client = await createOpenAiClient();
  const response = await (client as any).responses.create({
    model: "gpt-4.1-mini",
    input: buildAiPrompt(trade, deterministicPostMortem),
  });
  const outputText = typeof response?.output_text === "string"
    ? response.output_text.trim()
    : "";
  if (!outputText) {
    throw new Error("Loss post-mortem AI returned no text.");
  }

  return normalizeLossPostMortemAiReviewForTest(
    JSON.parse(extractJsonObject(outputText)),
    deterministicPostMortem,
  );
}
