import { DEFAULT_SCAN_PROMPT } from "../config/defaultScanPrompt.js";
import type { AccountMode } from "../journal/types.js";
import {
  SUPPORT_RESISTANCE_PROFILE,
  type SupportResistanceProfile,
} from "./supportResistanceStrategy.js";

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
const DEFAULT_LIVE_WEEKEND_ENTRY_CUTOFF_CT = "14:30";
const DEFAULT_LIVE_WEEKEND_EXIT_CUTOFF_CT = "14:45";
export const TRADESTATION_SIM_AUTOMATION_BASE_URL = "https://sim-api.tradestation.com/v3";
export const TRADESTATION_LIVE_AUTOMATION_BASE_URL = "https://api.tradestation.com/v3";

export type TradeStationEnvironment = "sim" | "live";
export type AutomationLane = AccountMode;
export type LiveEntryMode = "disabled" | "shadow" | "live";

export type PaperTraderConfig = {
  enabled: boolean;
  entryMode: LiveEntryMode;
  allowEntryOrders: boolean;
  allowExitOrders: boolean;
  /** @deprecated Use allowEntryOrders. Retained while callers migrate. */
  allowOrderPlacement: boolean;
  manageEntryOrders: boolean;
  maxOpenTrades: number | null;
  maxDailyLossUsd: number | null;
  maxPositionPct: number;
  scanPrompt: string;
  automationBaseUrl: string;
  tradeStationEnvironment: TradeStationEnvironment;
  accountMode: AccountMode;
  lane: AutomationLane;
  accountId: string | null;
  weekendGuardEnabled: boolean;
  weekendEntryCutoffMinutesCt: number;
  weekendExitCutoffMinutesCt: number;
  openingStopBypassEnabled: boolean;
  strategyProfile: SupportResistanceProfile | null;
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

function parseTimeOfDayMinutes(value: string, name: string): number {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match?.[1] || !match[2]) {
    throw new Error(`${name} must be in HH:MM 24-hour Central time.`);
  }

  return (Number(match[1]) * 60) + Number(match[2]);
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

function configLabelForLane(lane: AutomationLane): string {
  return lane === "live" ? "LIVE" : "PAPER";
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

  const paperAllowOrderPlacement = lane === "paper"
    ? readBooleanEnvFrom([PAPER_AUTO_TRADER_ALLOW_ORDER_PLACEMENT_ENV], false)
    : false;
  const entryMode: LiveEntryMode = lane === "live"
    ? "live"
    : paperAllowOrderPlacement
      ? "live"
      : "disabled";
  const allowEntryOrders = lane === "live" || paperAllowOrderPlacement;
  const allowExitOrders = lane === "live" || paperAllowOrderPlacement;

  return {
    enabled: true,
    entryMode,
    allowEntryOrders,
    allowExitOrders,
    allowOrderPlacement: allowEntryOrders,
    manageEntryOrders: lane === "live"
      ? true
      : readBooleanEnvFrom([PAPER_AUTO_TRADER_MANAGE_ENTRY_ORDERS_ENV], false),
    maxOpenTrades: null,
    maxDailyLossUsd: null,
    maxPositionPct: lane === "live"
      ? SUPPORT_RESISTANCE_PROFILE.positionPct
      : readPositiveRatioEnvFrom([PAPER_AUTO_TRADER_MAX_POSITION_PCT_ENV], 0.1),
    scanPrompt: lane === "live"
      ? SUPPORT_RESISTANCE_PROFILE.scanPrompt
      : readStringEnvFrom([PAPER_AUTO_TRADER_SCAN_PROMPT_ENV]) ?? DEFAULT_SCAN_PROMPT,
    automationBaseUrl,
    tradeStationEnvironment,
    accountMode: lane,
    lane,
    accountId: readStringEnvFrom(accountIdEnvNamesForLane(lane)),
    weekendGuardEnabled: false,
    weekendEntryCutoffMinutesCt: parseTimeOfDayMinutes(
      DEFAULT_LIVE_WEEKEND_ENTRY_CUTOFF_CT,
      "DEFAULT_LIVE_WEEKEND_ENTRY_CUTOFF_CT",
    ),
    weekendExitCutoffMinutesCt: parseTimeOfDayMinutes(
      DEFAULT_LIVE_WEEKEND_EXIT_CUTOFF_CT,
      "DEFAULT_LIVE_WEEKEND_EXIT_CUTOFF_CT",
    ),
    openingStopBypassEnabled: false,
    strategyProfile: lane === "live" ? SUPPORT_RESISTANCE_PROFILE : null,
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
}
