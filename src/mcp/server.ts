import { runScan, type ScanInput, type ScanResult } from "../app/runScan.js";
import { constructTradeCard, type TradeConstructionInput, type TradeConstructionResult } from "../app/runTradeConstruction.js";

export const scanToolDefinition = {
  name: "scan_prompt_to_best_ticker",
  description:
    "Run a read-only scan. Uses real TradeStation data for single-symbol prompts and a tiny V1 scan-universe scan for general prompts.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      excludedTickers: { type: "array", items: { type: "string" } },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
} as const;

export const tradeConstructionToolDefinition = {
  name: "construct_trade_card",
  description:
    "Build a read-only first-pass 2:1 options trade card for a confirmed ticker. Prompt forms: build trade OXY, trade setup OXY, construct trade OXY.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      confirmedDirection: { type: "string", enum: ["bullish", "bearish"] },
      confirmedConfidence: { type: "string", enum: ["65-74", "75-84", "85-92", "93-97"] },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
} as const;

export function isScanInput(value: unknown): value is ScanInput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const input = value as Partial<ScanInput>;
  if (typeof input.prompt !== "string") {
    return false;
  }

  if (input.excludedTickers === undefined) {
    return true;
  }

  return Array.isArray(input.excludedTickers) && input.excludedTickers.every((item) => typeof item === "string");
}

export function isTradeConstructionInput(value: unknown): value is TradeConstructionInput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const input = value as Partial<TradeConstructionInput>;
  if (typeof input.prompt !== "string") {
    return false;
  }

  if (input.confirmedDirection !== undefined && input.confirmedDirection !== "bullish" && input.confirmedDirection !== "bearish") {
    return false;
  }

  if (
    input.confirmedConfidence !== undefined &&
    !["65-74", "75-84", "85-92", "93-97"].includes(input.confirmedConfidence)
  ) {
    return false;
  }

  return true;
}

export async function callScanTool(input: unknown): Promise<ScanResult> {
  if (!isScanInput(input)) {
    throw new Error("Invalid input. Expected: { prompt: string, excludedTickers?: string[] }");
  }

  return runScan(input);
}

export async function callTradeConstructionTool(input: unknown): Promise<TradeConstructionResult> {
  if (!isTradeConstructionInput(input)) {
    throw new Error(
      "Invalid input. Expected: { prompt: string, confirmedDirection?: 'bullish'|'bearish', confirmedConfidence?: '65-74'|'75-84'|'85-92'|'93-97' }",
    );
  }

  return constructTradeCard(input);
}
