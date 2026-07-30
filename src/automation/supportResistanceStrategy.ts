import type { ScanResult } from "../app/runScan.js";
import { SUPPORT_RESISTANCE_V1 } from "./strategyVersion.js";

export const SUPPORT_RESISTANCE_SCAN_PROMPT =
  "Run a new Scan for this week using only clean support and resistance structure, chart-anchored invalidation, and clear 2:1 room.";

export const SUPPORT_RESISTANCE_MANAGEMENT_STYLE = "fixed_support_resistance";
export const SUPPORT_RESISTANCE_MIN_CONFIDENCE = 75;
export const SUPPORT_RESISTANCE_POSITION_PCT = 0.3;
export const SUPPORT_RESISTANCE_ENTRY_REPRICE_AFTER_SECONDS = 90;
export const SUPPORT_RESISTANCE_MAX_REPRICES = 1;
export const SUPPORT_RESISTANCE_ENTRY_CANCEL_AFTER_SECONDS = 300;
export const SUPPORT_RESISTANCE_OPTION_LOSS_EXIT_PCT = 0.25;

export type SupportResistanceProfile = {
  strategyVersion: typeof SUPPORT_RESISTANCE_V1;
  scanPrompt: typeof SUPPORT_RESISTANCE_SCAN_PROMPT;
  managementStyle: typeof SUPPORT_RESISTANCE_MANAGEMENT_STYLE;
  minimumConfidence: typeof SUPPORT_RESISTANCE_MIN_CONFIDENCE;
  positionPct: typeof SUPPORT_RESISTANCE_POSITION_PCT;
};

export const SUPPORT_RESISTANCE_PROFILE: SupportResistanceProfile = {
  strategyVersion: SUPPORT_RESISTANCE_V1,
  scanPrompt: SUPPORT_RESISTANCE_SCAN_PROMPT,
  managementStyle: SUPPORT_RESISTANCE_MANAGEMENT_STYLE,
  minimumConfidence: SUPPORT_RESISTANCE_MIN_CONFIDENCE,
  positionPct: SUPPORT_RESISTANCE_POSITION_PCT,
};

export function isSupportResistanceScanEligible(scan: ScanResult): boolean {
  return (
    scan.conclusion === "confirmed"
    && scan.ticker !== null
    && scan.direction !== null
    && scan.confidence !== null
    && scan.confidence !== "65-74"
  );
}
