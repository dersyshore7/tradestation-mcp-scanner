import { decideAiManagementAction, enforceAiManagementGuardrails } from "../automation/aiManager.js";
import { readPaperTraderConfig } from "../automation/config.js";
import { createAutomationTradeStationClient } from "../automation/tradestation.js";
import { createJournalTrade, getJournalTradeById } from "../journal/repository.js";
import type { AccountMode, JournalTradeDetail, TradeDirection } from "../journal/types.js";

export type LateTradeReviewInput = {
  account_mode: AccountMode;
  symbol: string;
  direction: TradeDirection;
  entry_date: string;
  entry_time: string | null;
  expiration_date: string | null;
  contracts: number;
  option_entry_price: number;
  underlying_entry_price: number | null;
  current_underlying_price: number | null;
  current_option_mid: number | null;
  option_symbol: string | null;
  current_stop_underlying: number | null;
  current_target_underlying: number | null;
  rationale: string | null;
  entry_notes: string | null;
  save_to_journal: boolean;
};

export type LateTradeReviewResult = {
  decision: {
    action: "hold" | "update_levels" | "exit_now";
    updatedStopUnderlying: number | null;
    updatedTargetUnderlying: number | null;
    confidence: "low" | "medium" | "high";
    thesis: string;
    note: string;
  };
  trade: JournalTradeDetail | null;
  metrics: {
    currentUnderlyingPrice: number | null;
    currentOptionMid: number | null;
    optionReturnPct: number | null;
    progressToTargetPct: number | null;
  };
  quote_status: {
    underlying: "manual" | "fetched" | "missing";
    option: "manual" | "fetched" | "missing";
    errors: string[];
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Payload must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return readString(value, field);
}

function readNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim().replace(/,/g, ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`${field} must be a valid number.`);
}

function optionalPositiveNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = readNumber(value, field);
  if (parsed <= 0) {
    throw new Error(`${field} must be > 0.`);
  }
  return parsed;
}

function readPositiveNumber(value: unknown, field: string): number {
  const parsed = readNumber(value, field);
  if (parsed <= 0) {
    throw new Error(`${field} must be > 0.`);
  }
  return parsed;
}

function readPositiveInteger(value: unknown, field: string): number {
  const parsed = readNumber(value, field);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be an integer > 0.`);
  }
  return parsed;
}

function readDate(value: unknown, field: string): string {
  const date = readString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${field} must be YYYY-MM-DD.`);
  }
  return date;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return readDate(value, field);
}

function optionalTime(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const time = readString(value, field);
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time)) {
    throw new Error(`${field} must be HH:MM or HH:MM:SS.`);
  }
  return time;
}

function coerceDirection(value: unknown): TradeDirection {
  const raw = readString(value, "direction").toUpperCase();
  if (raw === "CALL" || raw === "BULLISH") {
    return "CALL";
  }
  if (raw === "PUT" || raw === "BEARISH") {
    return "PUT";
  }
  throw new Error("direction must be CALL or PUT.");
}

function coerceAccountMode(value: unknown): AccountMode {
  const raw = readString(value, "account_mode").toLowerCase();
  if (raw === "paper" || raw === "live") {
    return raw;
  }
  throw new Error("account_mode must be paper or live.");
}

function calculateDteAtEntry(entryDate: string, expirationDate: string | null): number | null {
  if (!expirationDate) {
    return null;
  }
  const entry = new Date(`${entryDate}T00:00:00Z`);
  const expiration = new Date(`${expirationDate}T00:00:00Z`);
  if (Number.isNaN(entry.getTime()) || Number.isNaN(expiration.getTime())) {
    return null;
  }
  const days = Math.ceil((expiration.getTime() - entry.getTime()) / 86400000);
  return days > 0 ? days : null;
}

function computeProgressToTargetPct(params: {
  direction: TradeDirection;
  entryUnderlyingPrice: number | null;
  currentUnderlyingPrice: number | null;
  targetUnderlyingPrice: number | null;
}): number | null {
  const { direction, entryUnderlyingPrice, currentUnderlyingPrice, targetUnderlyingPrice } = params;
  if (
    entryUnderlyingPrice === null
    || currentUnderlyingPrice === null
    || targetUnderlyingPrice === null
    || entryUnderlyingPrice === targetUnderlyingPrice
  ) {
    return null;
  }

  const progress = direction === "CALL"
    ? (currentUnderlyingPrice - entryUnderlyingPrice) / (targetUnderlyingPrice - entryUnderlyingPrice)
    : (entryUnderlyingPrice - currentUnderlyingPrice) / (entryUnderlyingPrice - targetUnderlyingPrice);

  return Number.isFinite(progress) ? Number((progress * 100).toFixed(1)) : null;
}

function computeOptionReturnPct(entryOptionPrice: number, currentOptionMid: number | null): number | null {
  if (currentOptionMid === null || entryOptionPrice <= 0) {
    return null;
  }
  return Number((((currentOptionMid - entryOptionPrice) / entryOptionPrice) * 100).toFixed(1));
}

export function validateLateTradeReviewPayload(payload: unknown): LateTradeReviewInput {
  const input = asRecord(payload);
  const entryDate = readDate(input.entry_date, "entry_date");
  const expirationDate = optionalDate(input.expiration_date, "expiration_date");
  if (expirationDate && expirationDate < entryDate) {
    throw new Error("expiration_date must be on/after entry_date.");
  }

  return {
    account_mode: coerceAccountMode(input.account_mode ?? "paper"),
    symbol: readString(input.symbol, "symbol").toUpperCase(),
    direction: coerceDirection(input.direction),
    entry_date: entryDate,
    entry_time: optionalTime(input.entry_time, "entry_time"),
    expiration_date: expirationDate,
    contracts: readPositiveInteger(input.contracts, "contracts"),
    option_entry_price: readPositiveNumber(input.option_entry_price, "option_entry_price"),
    underlying_entry_price: optionalPositiveNumber(input.underlying_entry_price, "underlying_entry_price"),
    current_underlying_price: optionalPositiveNumber(input.current_underlying_price, "current_underlying_price"),
    current_option_mid: optionalPositiveNumber(input.current_option_mid, "current_option_mid"),
    option_symbol: optionalString(input.option_symbol, "option_symbol"),
    current_stop_underlying: optionalPositiveNumber(input.current_stop_underlying, "current_stop_underlying"),
    current_target_underlying: optionalPositiveNumber(input.current_target_underlying, "current_target_underlying"),
    rationale: optionalString(input.rationale, "rationale"),
    entry_notes: optionalString(input.entry_notes, "entry_notes"),
    save_to_journal: input.save_to_journal !== false,
  };
}

async function resolveCurrentPrices(input: LateTradeReviewInput): Promise<{
  currentUnderlyingPrice: number | null;
  currentOptionMid: number | null;
  quoteStatus: LateTradeReviewResult["quote_status"];
}> {
  let currentUnderlyingPrice = input.current_underlying_price;
  let currentOptionMid = input.current_option_mid;
  const errors: string[] = [];

  if (currentUnderlyingPrice === null || (currentOptionMid === null && input.option_symbol)) {
    try {
      const client = await createAutomationTradeStationClient(readPaperTraderConfig().automationBaseUrl);
      if (currentUnderlyingPrice === null) {
        const quote = await client.fetchQuote(input.symbol);
        currentUnderlyingPrice = quote.last;
      }
      if (currentOptionMid === null && input.option_symbol) {
        const quote = await client.fetchQuote(input.option_symbol);
        currentOptionMid = quote.mid ?? quote.last;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Failed to fetch current quotes.");
    }
  }

  return {
    currentUnderlyingPrice,
    currentOptionMid,
    quoteStatus: {
      underlying: input.current_underlying_price !== null
        ? "manual"
        : currentUnderlyingPrice !== null
          ? "fetched"
          : "missing",
      option: input.current_option_mid !== null
        ? "manual"
        : currentOptionMid !== null
          ? "fetched"
          : "missing",
      errors,
    },
  };
}

export async function reviewLateTrade(input: LateTradeReviewInput): Promise<LateTradeReviewResult> {
  const { currentUnderlyingPrice, currentOptionMid, quoteStatus } = await resolveCurrentPrices(input);
  const dteAtEntry = calculateDteAtEntry(input.entry_date, input.expiration_date);
  const positionCostUsd = input.contracts * input.option_entry_price * 100;
  const progressToTargetPct = computeProgressToTargetPct({
    direction: input.direction,
    entryUnderlyingPrice: input.underlying_entry_price,
    currentUnderlyingPrice,
    targetUnderlyingPrice: input.current_target_underlying,
  });
  const optionReturnPct = computeOptionReturnPct(input.option_entry_price, currentOptionMid);
  const rawDecision = await decideAiManagementAction({
    symbol: input.symbol,
    direction: input.direction,
    setupType: "manual_late_entry",
    confidenceBucket: null,
    entryDate: input.entry_date,
    expirationDate: input.expiration_date,
    dteAtEntry,
    underlyingEntryPrice: input.underlying_entry_price,
    optionEntryPrice: input.option_entry_price,
    currentUnderlyingPrice,
    currentOptionMid,
    currentStopUnderlying: input.current_stop_underlying,
    currentTargetUnderlying: input.current_target_underlying,
    originalStopUnderlying: input.current_stop_underlying,
    originalTargetUnderlying: input.current_target_underlying,
    timeExitDate: null,
    progressToTargetPct,
    optionReturnPct,
    rationale: input.rationale,
    lastManagementNote: null,
    lastManagementThesis: null,
    managementHistorySummary: "Late manual review: no prior saved scanner recommendation or management history is available.",
    policyFeedbackSummary: null,
    trainedPolicySummary: null,
    trainedPolicyRecommendedAction: null,
  });
  const decision = enforceAiManagementGuardrails(
    input.direction,
    input.current_stop_underlying,
    input.current_target_underlying,
    currentUnderlyingPrice,
    rawDecision,
  );
  let trade: JournalTradeDetail | null = null;

  if (input.save_to_journal) {
    const created = await createJournalTrade({
      account_mode: input.account_mode,
      entry_date: input.entry_date,
      entry_time: input.entry_time,
      contracts: input.contracts,
      option_entry_price: input.option_entry_price,
      entry_notes: input.entry_notes ?? "Late manual entry reviewed after the trade was already open.",
      planned_trade: {
        scan_run_id: `late_review_${Date.now()}`,
        symbol: input.symbol,
        direction: input.direction,
        expiration_date: input.expiration_date,
        dte_at_entry: dteAtEntry,
        position_cost_usd: positionCostUsd,
        underlying_entry_price: input.underlying_entry_price,
        setup_type: "manual_late_entry",
        confidence_bucket: "late_manual",
        intended_stop_underlying: input.current_stop_underlying,
        intended_target_underlying: input.current_target_underlying,
      },
      signal_snapshot_json: {
        lateTradeReview: {
          input,
          currentUnderlyingPrice,
          currentOptionMid,
          quoteStatus,
          decision,
          reviewedAt: new Date().toISOString(),
          note: "Decision support only. No order was placed.",
        },
        automation: {
          lane: "manual_late_review",
          paperTrader: {
            optionSymbol: input.option_symbol,
            quantity: input.contracts,
            intendedStopUnderlying: input.current_stop_underlying,
            intendedTargetUnderlying: input.current_target_underlying,
            activeStopUnderlying: decision.updatedStopUnderlying ?? input.current_stop_underlying,
            activeTargetUnderlying: decision.updatedTargetUnderlying ?? input.current_target_underlying,
            managementStyle: "manual_review",
            lastManagementAction: decision.action,
            lastManagementConfidence: decision.confidence,
            lastManagementNote: decision.note,
            lastManagementThesis: decision.thesis,
            lastManagementAt: new Date().toISOString(),
          },
        },
      },
    });

    trade = await getJournalTradeById(created.id);
  }

  return {
    decision,
    trade,
    metrics: {
      currentUnderlyingPrice,
      currentOptionMid,
      optionReturnPct,
      progressToTargetPct,
    },
    quote_status: quoteStatus,
  };
}
