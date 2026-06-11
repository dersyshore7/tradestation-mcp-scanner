import { DEFAULT_SCAN_PROMPT } from "../config/defaultScanPrompt.js";
import type { AccountMode } from "../journal/types.js";

const AUTO_TRADER_API_SECRET_ENV = "AUTO_TRADER_API_SECRET";
const TRADESTATION_AUTOMATION_BASE_URL_ENV = "TRADESTATION_AUTOMATION_BASE_URL";
const TRADESTATION_AUTOMATION_ACCOUNT_ID_ENV = "TRADESTATION_AUTOMATION_ACCOUNT_ID";
const PAPER_TRADESTATION_AUTOMATION_BASE_URL_ENV = "PAPER_TRADESTATION_AUTOMATION_BASE_URL";
const PAPER_TRADESTATION_AUTOMATION_ACCOUNT_ID_ENV = "PAPER_TRADESTATION_AUTOMATION_ACCOUNT_ID";
const PAPER_AUTO_TRADER_ALLOW_ORDER_PLACEMENT_ENV = "PAPER_AUTO_TRADER_ALLOW_ORDER_PLACEMENT";
const PAPER_AUTO_TRADER_MANAGE_ENTRY_ORDERS_ENV = "PAPER_AUTO_TRADER_MANAGE_ENTRY_ORDERS";
const PAPER_AUTO_TRADER_MAX_POSITION_PCT_ENV = "PAPER_AUTO_TRADER_MAX_POSITION_PCT";
const PAPER_AUTO_TRADER_SCAN_PROMPT_ENV = "PAPER_AUTO_TRADER_SCAN_PROMPT";
const LIVE_TRADESTATION_AUTOMATION_BASE_URL_ENV = "LIVE_TRADESTATION_AUTOMATION_BASE_URL";
const LIVE_TRADESTATION_AUTOMATION_ACCOUNT_ID_ENV = "LIVE_TRADESTATION_AUTOMATION_ACCOUNT_ID";
const LIVE_AUTO_TRADER_ALLOW_ORDER_PLACEMENT_ENV = "LIVE_AUTO_TRADER_ALLOW_ORDER_PLACEMENT";
const LIVE_AUTO_TRADER_MANAGE_ENTRY_ORDERS_ENV = "LIVE_AUTO_TRADER_MANAGE_ENTRY_ORDERS";
const LIVE_AUTO_TRADER_MAX_POSITION_PCT_ENV = "LIVE_AUTO_TRADER_MAX_POSITION_PCT";
const LIVE_AUTO_TRADER_SCAN_PROMPT_ENV = "LIVE_AUTO_TRADER_SCAN_PROMPT";
export const TRADESTATION_SIM_AUTOMATION_BASE_URL = "https://sim-api.tradestation.com/v3";
export const TRADESTATION_LIVE_AUTOMATION_BASE_URL = "https://api.tradestation.com/v3";

export type TradeStationEnvironment = "sim" | "live";
export type AutomationLane = AccountMode;

export type PaperTraderConfig = {
  enabled: boolean;
  allowOrderPlacement: boolean;
  manageEntryOrders: boolean;
  maxOpenTrades: number | null;
  maxDailyLossUsd: number | null;
  maxPositionPct: number;
  scanPrompt: string;
  apiSecret: string | null;
  automationBaseUrl: string;
  tradeStationEnvironment: TradeStationEnvironment;
  accountMode: AccountMode;
  lane: AutomationLane;
  accountId: string | null;
};

function readStringEnv(name: string): string | null {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return null;
  }

  return value.trim();
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = readStringEnv(name);
  if (value === null) {
    return defaultValue;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function readPositiveRatioEnv(name: string, fallback: number): number {
  const value = readStringEnv(name);
  if (value === null) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  const ratio = parsed > 1 ? parsed / 100 : parsed;
  if (ratio <= 0 || ratio > 1) {
    throw new Error(`${name} must be between 0 and 1, or a percent between 1 and 100.`);
  }

  return ratio;
}

function readPositiveRatioEnvFrom(names: string[], fallback: number): number {
  const name = names.find((candidate) => readStringEnv(candidate) !== null);
  return name ? readPositiveRatioEnv(name, fallback) : fallback;
}

function readBooleanEnvFrom(names: string[], defaultValue: boolean): boolean {
  const name = names.find((candidate) => readStringEnv(candidate) !== null);
  return name ? readBooleanEnv(name, defaultValue) : defaultValue;
}

function readStringEnvFrom(names: string[]): string | null {
  for (const name of names) {
    const value = readStringEnv(name);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

export function isTradeStationSimBaseUrl(value: string): boolean {
  return value.replace(/\/$/, "") === TRADESTATION_SIM_AUTOMATION_BASE_URL;
}

export function isTradeStationLiveBaseUrl(value: string): boolean {
  return value.replace(/\/$/, "") === TRADESTATION_LIVE_AUTOMATION_BASE_URL;
}

export function readTradeStationEnvironment(value: string): TradeStationEnvironment | null {
  const normalized = value.replace(/\/$/, "");
  if (normalized === TRADESTATION_SIM_AUTOMATION_BASE_URL) {
    return "sim";
  }
  if (normalized === TRADESTATION_LIVE_AUTOMATION_BASE_URL) {
    return "live";
  }
  return null;
}

export function isRecognizedTradeStationAutomationBaseUrl(value: string): boolean {
  return readTradeStationEnvironment(value) !== null;
}

export function readAutomationLane(value: unknown): AutomationLane | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "paper" || normalized === "live"
    ? normalized
    : null;
}

function expectedTradeStationEnvironmentForLane(lane: AutomationLane): TradeStationEnvironment {
  return lane === "live" ? "live" : "sim";
}

function defaultTradeStationBaseUrlForLane(lane: AutomationLane): string {
  return lane === "live"
    ? TRADESTATION_LIVE_AUTOMATION_BASE_URL
    : TRADESTATION_SIM_AUTOMATION_BASE_URL;
}

function baseUrlEnvNamesForLane(lane: AutomationLane): string[] {
  return lane === "live"
    ? [LIVE_TRADESTATION_AUTOMATION_BASE_URL_ENV, TRADESTATION_AUTOMATION_BASE_URL_ENV]
    : [PAPER_TRADESTATION_AUTOMATION_BASE_URL_ENV];
}

function accountIdEnvNamesForLane(lane: AutomationLane): string[] {
  return lane === "live"
    ? [
        LIVE_TRADESTATION_AUTOMATION_ACCOUNT_ID_ENV,
        TRADESTATION_AUTOMATION_ACCOUNT_ID_ENV,
        "TRADESTATION_ACCOUNT_ID",
      ]
    : [PAPER_TRADESTATION_AUTOMATION_ACCOUNT_ID_ENV];
}

function allowOrderPlacementEnvNamesForLane(lane: AutomationLane): string[] {
  return lane === "live"
    ? [LIVE_AUTO_TRADER_ALLOW_ORDER_PLACEMENT_ENV]
    : [PAPER_AUTO_TRADER_ALLOW_ORDER_PLACEMENT_ENV];
}

function manageEntryOrdersEnvNamesForLane(lane: AutomationLane): string[] {
  return lane === "live"
    ? [LIVE_AUTO_TRADER_MANAGE_ENTRY_ORDERS_ENV]
    : [PAPER_AUTO_TRADER_MANAGE_ENTRY_ORDERS_ENV];
}

function maxPositionPctEnvNamesForLane(lane: AutomationLane): string[] {
  return lane === "live"
    ? [LIVE_AUTO_TRADER_MAX_POSITION_PCT_ENV]
    : [PAPER_AUTO_TRADER_MAX_POSITION_PCT_ENV];
}

function scanPromptEnvNamesForLane(lane: AutomationLane): string[] {
  return lane === "live"
    ? [LIVE_AUTO_TRADER_SCAN_PROMPT_ENV]
    : [PAPER_AUTO_TRADER_SCAN_PROMPT_ENV];
}

function configLabelForLane(lane: AutomationLane): string {
  return lane === "live" ? "LIVE" : "PAPER";
}

export function readPaperTraderApiSecrets(): string[] {
  return [
    readStringEnv(AUTO_TRADER_API_SECRET_ENV),
    readStringEnv("CRON_SECRET"),
  ].filter((value, index, values): value is string =>
    value !== null && values.indexOf(value) === index
  );
}

export function readPaperTraderConfig(lane: AutomationLane = "paper"): PaperTraderConfig {
  const automationBaseUrl = (
    readStringEnvFrom(baseUrlEnvNamesForLane(lane))
    ?? defaultTradeStationBaseUrlForLane(lane)
  ).replace(/\/$/, "");
  const tradeStationEnvironment = readTradeStationEnvironment(automationBaseUrl);
  if (!tradeStationEnvironment) {
    throw new Error(
      `${configLabelForLane(lane)} automation base URL must be ${TRADESTATION_SIM_AUTOMATION_BASE_URL} for PAPER or ${TRADESTATION_LIVE_AUTOMATION_BASE_URL} for LIVE.`,
    );
  }

  const expectedEnvironment = expectedTradeStationEnvironmentForLane(lane);
  if (tradeStationEnvironment !== expectedEnvironment) {
    throw new Error(
      `${configLabelForLane(lane)} automation must use the ${expectedEnvironment === "live" ? "LIVE" : "SIM"} TradeStation URL.`,
    );
  }

  return {
    enabled: true,
    allowOrderPlacement: readBooleanEnvFrom(allowOrderPlacementEnvNamesForLane(lane), false),
    manageEntryOrders: readBooleanEnvFrom(manageEntryOrdersEnvNamesForLane(lane), false),
    maxOpenTrades: null,
    maxDailyLossUsd: null,
    maxPositionPct: readPositiveRatioEnvFrom(maxPositionPctEnvNamesForLane(lane), 0.1),
    scanPrompt: readStringEnvFrom(scanPromptEnvNamesForLane(lane)) ?? DEFAULT_SCAN_PROMPT,
    apiSecret: readPaperTraderApiSecrets()[0] ?? null,
    automationBaseUrl,
    tradeStationEnvironment,
    accountMode: lane,
    lane,
    accountId: readStringEnvFrom(accountIdEnvNamesForLane(lane)),
  };
}

export function assertPaperTraderConfig(config: PaperTraderConfig): void {
  if (!config.accountId) {
    throw new Error(
      `Missing ${accountIdEnvNamesForLane(config.lane)[0]}. The ${config.lane} automation requires a TradeStation account id.`,
    );
  }

  if (!isRecognizedTradeStationAutomationBaseUrl(config.automationBaseUrl)) {
    throw new Error(
      `${configLabelForLane(config.lane)} automation base URL must be ${TRADESTATION_SIM_AUTOMATION_BASE_URL} for PAPER or ${TRADESTATION_LIVE_AUTOMATION_BASE_URL} for LIVE.`,
    );
  }

  const expectedEnvironment = expectedTradeStationEnvironmentForLane(config.lane);
  if (config.tradeStationEnvironment !== expectedEnvironment) {
    throw new Error(
      `${configLabelForLane(config.lane)} automation must use the ${expectedEnvironment === "live" ? "LIVE" : "SIM"} TradeStation URL.`,
    );
  }

  if (config.allowOrderPlacement && !config.apiSecret) {
    throw new Error(
      `Set ${AUTO_TRADER_API_SECRET_ENV} or CRON_SECRET before enabling order placement.`,
    );
  }
}
