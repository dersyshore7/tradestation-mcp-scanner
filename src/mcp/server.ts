import { runFakeScan, type ScanInput, type ScanResult } from "../app/runScan.js";

type ScanToolName = "scan_prompt_to_best_ticker";

type McpToolDefinition = {
  name: ScanToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: {
      prompt: { type: "string" };
      excludedTickers: { type: "array"; items: { type: "string" } };
    };
    required: ["prompt"];
    additionalProperties: false;
  };
};

export const scanToolDefinition: McpToolDefinition = {
  name: "scan_prompt_to_best_ticker",
  description: "Run a fake local scan and return a single mock ticker decision.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      excludedTickers: { type: "array", items: { type: "string" } },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

function isScanInput(value: unknown): value is ScanInput {
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

/**
 * Minimal local MCP skeleton.
 * This keeps things beginner-friendly and in-process for now.
 */
export class LocalMcpServer {
  readonly name = "tradestation-mcp-scanner-local";
  readonly version = "0.1.0";

  listTools(): McpToolDefinition[] {
    return [scanToolDefinition];
  }

  callTool(name: string, input: unknown): ScanResult {
    if (name !== "scan_prompt_to_best_ticker") {
      throw new Error(`Unknown tool: ${name}`);
    }

    if (!isScanInput(input)) {
      throw new Error("Invalid input. Expected: { prompt: string, excludedTickers?: string[] }");
    }

    return runFakeScan(input);
  }
}
