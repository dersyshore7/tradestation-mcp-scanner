import { DEFAULT_SCAN_PROMPT } from "../config/defaultScanPrompt.js";

const AUTO_TRADER_ENABLED_ENV = "AUTO_TRADER_ENABLED";
const AUTO_TRADER_ALLOW_ORDER_PLACEMENT_ENV = "AUTO_TRADER_ALLOW_ORDER_PLACEMENT";
const AUTO_TRADER_MAX_OPEN_TRADES_ENV = "AUTO_TRADER_MAX_OPEN_TRADES";
const AUTO_TRADER_MAX_DAILY_LOSS_USD_ENV = "AUTO_TRADER_MAX_DAILY_LOSS_USD";
const AUTO_TRADER_SCAN_PROMPT_ENV = "AUTO_TRADER_SCAN_PROMPT";
const AUTO_TRADER_API_SECRET_ENV = "AUTO_TRADER_API_SECRET";
const TRADESTATION_AUTOMATION_BASE_URL_ENV = "TRADESTATION_AUTOMATION_BASE_URL";
const TRADESTATION_AUTOMATION_ACCOUNT_ID_ENV = "TRADESTATION_AUTOMATION_ACCOUNT_ID";

export type PaperTraderConfig = {
  enabled: boolean;
  allowOrderPlacement: boolean;
  maxOpenTrades: number;
  maxDailyLossUsd: number;
  scanPrompt: string;
  apiSecret: string | null;
  automationBaseUrl: string;
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

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = readStringEnv(name);
  if (value === null) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be an integer > 0.`);
  }

  return parsed;
}

function readPositiveNumberEnv(name: string, fallback: number): number {
  const value = readStringEnv(name);
  if (value === null) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a number > 0.`);
  }

  return parsed;
}

export function isTradeStationSimBaseUrl(value: string): boolean {
  return value.includes("sim-api.tradestation.com");
}

export function readPaperTraderConfig(): PaperTraderConfig {
  const automationBaseUrl = (
    readStringEnv(TRADESTATION_AUTOMATION_BASE_URL_ENV)
    ?? readStringEnv("TRADESTATION_BASE_URL")
    ?? "https://sim-api.tradestation.com/v3"
  ).replace(/\/$/, "");

  return {
    enabled: readBooleanEnv(AUTO_TRADER_ENABLED_ENV, false),
    allowOrderPlacement: readBooleanEnv(AUTO_TRADER_ALLOW_ORDER_PLACEMENT_ENV, false),
    maxOpenTrades: readPositiveIntegerEnv(AUTO_TRADER_MAX_OPEN_TRADES_ENV, 1),
    maxDailyLossUsd: readPositiveNumberEnv(AUTO_TRADER_MAX_DAILY_LOSS_USD_ENV, 300),
    scanPrompt: readStringEnv(AUTO_TRADER_SCAN_PROMPT_ENV) ?? DEFAULT_SCAN_PROMPT,
    apiSecret: readStringEnv(AUTO_TRADER_API_SECRET_ENV) ?? readStringEnv("CRON_SECRET"),
    automationBaseUrl,
    accountId:
      readStringEnv(TRADESTATION_AUTOMATION_ACCOUNT_ID_ENV)
      ?? readStringEnv("TRADESTATION_ACCOUNT_ID"),
  };
}

export function assertPaperTraderConfig(config: PaperTraderConfig): void {
  if (!config.enabled) {
    throw new Error(`Set ${AUTO_TRADER_ENABLED_ENV}=1 to enable the paper trader module.`);
  }

  if (!config.accountId) {
    throw new Error(
      `Missing ${TRADESTATION_AUTOMATION_ACCOUNT_ID_ENV}. The paper trader requires a dedicated paper account id.`,
    );
  }

  if (!isTradeStationSimBaseUrl(config.automationBaseUrl)) {
    throw new Error(
      `Paper trader base URL must point to the TradeStation SIM environment. Set ${TRADESTATION_AUTOMATION_BASE_URL_ENV}=https://sim-api.tradestation.com/v3.`,
    );
  }

  if (config.allowOrderPlacement && !config.apiSecret) {
    throw new Error(
      `Set ${AUTO_TRADER_API_SECRET_ENV} or CRON_SECRET before enabling order placement.`,
    );
  }
}
