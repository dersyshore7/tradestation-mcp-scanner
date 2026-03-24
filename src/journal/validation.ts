import {
  ACCOUNT_MODES,
  TRADE_DIRECTIONS,
  TRADE_STATUSES,
  type JournalTradeCreateInput,
  type PlannedTradeSnapshot,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Payload must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    throw new Error(`${field} is required.`);
  }
  return trimmed;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return readString(value, field, false);
}

function parseNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
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
  const parsed = parseNumber(value, field);
  if (parsed <= 0) {
    throw new Error(`${field} must be > 0.`);
  }
  return parsed;
}

function optionalIntegerGreaterThanZero(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = parseNumber(value, field);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be an integer > 0.`);
  }
  return parsed;
}

function parseDate(value: unknown, field: string): string {
  const normalized = readString(value, field, false);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`${field} must be YYYY-MM-DD.`);
  }
  return normalized;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return parseDate(value, field);
}

function optionalTime(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized = readString(value, field, false);
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
    throw new Error(`${field} must be HH:MM or HH:MM:SS.`);
  }
  return normalized;
}

function coerceDirection(value: unknown): "CALL" | "PUT" {
  const raw = readString(value, "planned_trade.direction", false).toUpperCase();
  if (TRADE_DIRECTIONS.includes(raw as "CALL" | "PUT")) {
    return raw as "CALL" | "PUT";
  }
  if (raw === "BULLISH") {
    return "CALL";
  }
  if (raw === "BEARISH") {
    return "PUT";
  }
  throw new Error("planned_trade.direction must be CALL or PUT.");
}

function parsePlannedTrade(value: unknown, entryDate: string): PlannedTradeSnapshot {
  const payload = asRecord(value);
  const symbol = readString(payload.symbol, "planned_trade.symbol", false).toUpperCase();
  const expirationDate = optionalDate(payload.expiration_date, "planned_trade.expiration_date");
  if (expirationDate && expirationDate < entryDate) {
    throw new Error("planned_trade.expiration_date must be on/after entry_date.");
  }

  return {
    scan_run_id: optionalString(payload.scan_run_id, "planned_trade.scan_run_id"),
    symbol,
    direction: coerceDirection(payload.direction),
    expiration_date: expirationDate,
    dte_at_entry: optionalIntegerGreaterThanZero(payload.dte_at_entry, "planned_trade.dte_at_entry"),
    position_cost_usd: parsePositiveMoney(payload.position_cost_usd, "planned_trade.position_cost_usd"),
    underlying_entry_price: optionalPositiveNumber(payload.underlying_entry_price, "planned_trade.underlying_entry_price"),
    planned_risk_usd: optionalPositiveNumber(payload.planned_risk_usd, "planned_trade.planned_risk_usd"),
    planned_profit_usd: optionalPositiveNumber(payload.planned_profit_usd, "planned_trade.planned_profit_usd"),
    setup_type: readString(payload.setup_type, "planned_trade.setup_type", false),
    setup_subtype: optionalString(payload.setup_subtype, "planned_trade.setup_subtype"),
    confidence_bucket: optionalString(payload.confidence_bucket, "planned_trade.confidence_bucket"),
    intended_stop_underlying: optionalPositiveNumber(payload.intended_stop_underlying, "planned_trade.intended_stop_underlying"),
    intended_target_underlying: optionalPositiveNumber(payload.intended_target_underlying, "planned_trade.intended_target_underlying"),
    market_regime: optionalString(payload.market_regime, "planned_trade.market_regime"),
  };
}

function parsePositiveMoney(value: unknown, field: string): number {
  const parsed = parseNumber(value, field);
  if (parsed <= 0) {
    throw new Error(`${field} must be > 0.`);
  }
  return parsed;
}

export function validateJournalTradeCreatePayload(payload: unknown): JournalTradeCreateInput {
  const input = asRecord(payload);
  const accountMode = readString(input.account_mode, "account_mode", false).toLowerCase();
  if (!ACCOUNT_MODES.includes(accountMode as "paper" | "live")) {
    throw new Error("account_mode must be paper or live.");
  }

  const entryDate = parseDate(input.entry_date, "entry_date");
  const plannedTrade = parsePlannedTrade(input.planned_trade, entryDate);

  const statusRaw = input.status === undefined ? "open" : readString(input.status, "status", false).toLowerCase();
  if (!TRADE_STATUSES.includes(statusRaw as "open" | "closed")) {
    throw new Error("status must be open or closed.");
  }

  return {
    account_mode: accountMode as "paper" | "live",
    entry_date: entryDate,
    entry_time: optionalTime(input.entry_time, "entry_time"),
    contracts: optionalIntegerGreaterThanZero(input.contracts, "contracts"),
    option_entry_price: optionalPositiveNumber(input.option_entry_price, "option_entry_price"),
    entry_notes: optionalString(input.entry_notes, "entry_notes"),
    planned_trade: plannedTrade,
    signal_snapshot_json:
      input.signal_snapshot_json && typeof input.signal_snapshot_json === "object" && !Array.isArray(input.signal_snapshot_json)
        ? (input.signal_snapshot_json as Record<string, unknown>)
        : null,
    status: statusRaw as "open" | "closed",
  };
}
