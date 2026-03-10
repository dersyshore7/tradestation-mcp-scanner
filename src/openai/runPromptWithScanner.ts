import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ScanInput } from "../app/runScan.js";
import { callScanTool } from "../mcp/server.js";
import { createOpenAiClient } from "./client.js";

const TEST_PROMPT = "Find the best bullish ticker setup for today.";

function loadDotEnvFileIfPresent(): void {
  const envPath = resolve(process.cwd(), ".env");

  try {
    const contents = readFileSync(envPath, "utf8");

    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file is fine if OPENAI_API_KEY is already set.
  }
}

function parseScannerInput(input: string): ScanInput {
  const parsed = JSON.parse(input) as Partial<ScanInput>;

  if (typeof parsed.prompt !== "string") {
    throw new Error("Tool call input must include a prompt string.");
  }

  if (parsed.excludedTickers !== undefined) {
    const isValidExclusions =
      Array.isArray(parsed.excludedTickers) && parsed.excludedTickers.every((item) => typeof item === "string");

    if (!isValidExclusions) {
      throw new Error("excludedTickers must be a string array when provided.");
    }
  }

  if (parsed.excludedTickers) {
    return {
      prompt: parsed.prompt,
      excludedTickers: parsed.excludedTickers,
    };
  }

  return { prompt: parsed.prompt };
}

async function runPromptWithScanner(): Promise<void> {
  loadDotEnvFileIfPresent();

  const client = await createOpenAiClient();

  const firstResponse = await (client as any).responses.create({
    model: "gpt-4.1-mini",
    input: TEST_PROMPT,
    tools: [
      {
        type: "function",
        name: "scan_prompt_to_best_ticker",
        description: "Run the local fake scanner and return the best ticker decision.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            excludedTickers: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    ],
  });

  const toolCall = (firstResponse.output ?? []).find(
    (item: any) => item.type === "function_call" && item.name === "scan_prompt_to_best_ticker",
  );

  if (!toolCall) {
    console.log(firstResponse.output_text ?? "No tool call and no final text response.");
    return;
  }

  const scannerInput = parseScannerInput(toolCall.arguments ?? "{}");
  const scannerResult = callScanTool(scannerInput);

  const finalResponse = await (client as any).responses.create({
    model: "gpt-4.1-mini",
    previous_response_id: firstResponse.id,
    input: [
      {
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(scannerResult),
      },
    ],
  });

  console.log(finalResponse.output_text ?? "No final text returned.");
}

runPromptWithScanner();
