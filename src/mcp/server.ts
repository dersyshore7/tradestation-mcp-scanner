import { runScan, type ScanInput, type ScanResult } from "../app/runScan.js";

export const scanToolDefinition = {
  name: "scan_prompt_to_best_ticker",
  description:
    "Run a scan. Uses real TradeStation data for prompts like 'analyze AAPL', otherwise falls back to fake starter logic.",
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

export async function callScanTool(input: unknown): Promise<ScanResult> {
  if (!isScanInput(input)) {
    throw new Error("Invalid input. Expected: { prompt: string, excludedTickers?: string[] }");
  }

  return runScan(input);
}
