import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenAiClient } from "./client.js";
import { DEFAULT_SCAN_PROMPT } from "../config/defaultScanPrompt.js";
const REMOTE_SCANNER_MCP_URL = "https://tradestation-mcp-scanner.vercel.app/api/mcp";
const FINAL_ANSWER_FORMAT_REQUIREMENT =
  "Return exactly one sentence in this format: I think [TICKER] shows a (bullish/bearish) setup worth trading today (≈ XX% confidence). If there is no setup, return exactly one sentence in this format: No trade today — [reason].";

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

async function runPromptWithScanner(): Promise<void> {
  loadDotEnvFileIfPresent();

  const client = await createOpenAiClient();

  const response = await (client as any).responses.create({
    model: "gpt-4.1-mini",
    input: `Use the scanner MCP tool once with prompt \"${DEFAULT_SCAN_PROMPT}\". Do not pass excludedTickers unless they were explicitly provided by the user. Then return the final answer. ${FINAL_ANSWER_FORMAT_REQUIREMENT}`,
    tools: [
      {
        type: "mcp",
        server_label: "scanner",
        server_url: REMOTE_SCANNER_MCP_URL,
        allowed_tools: ["scan_prompt_to_best_ticker"],
        require_approval: "never",
      },
    ],
  });

  const outputItems = response.output ?? [];
  const usedMcpTool = outputItems.some((item: any) => {
    const itemType = typeof item?.type === "string" ? item.type : "";
    return itemType.includes("mcp") || itemType.includes("tool");
  });

  const initialOutputText =
    typeof response.output_text === "string" ? response.output_text.trim() : "";

  if (initialOutputText) {
    console.log(initialOutputText);
    return;
  }

  if (!usedMcpTool) {
    console.log("No final text returned.");
    return;
  }

  console.log("[debug] MCP/tool activity detected without final text; requesting summary.");

  const followUp = await (client as any).responses.create({
    model: "gpt-4.1-mini",
    previous_response_id: response.id,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Using the tool results you already retrieved, provide the final user-facing answer only. ${FINAL_ANSWER_FORMAT_REQUIREMENT}`,
          },
        ],
      },
    ],
  });

  const followUpText = typeof followUp.output_text === "string" ? followUp.output_text.trim() : "";
  console.log(followUpText || "No final text returned.");
}

runPromptWithScanner();
