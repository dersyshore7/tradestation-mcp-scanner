import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenAiClient } from "./client.js";

const TEST_PROMPT = "Find the best bullish ticker setup for today.";
const REMOTE_SCANNER_MCP_URL = "https://tradestation-mcp-scanner.vercel.app/api/mcp";

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
    input: TEST_PROMPT,
    tools: [
      {
        type: "mcp",
        server_label: "scanner",
        server_url: REMOTE_SCANNER_MCP_URL,
        allowed_tools: ["scan_prompt_to_best_ticker"],
      },
    ],
  });

  const outputItems = response.output ?? [];
  const usedMcpTool = outputItems.some((item: any) => {
    const itemType = typeof item?.type === "string" ? item.type : "";
    return itemType.includes("mcp") || itemType.includes("tool");
  });

  if (usedMcpTool) {
    console.log("[debug] MCP/tool activity detected in response output.");
  }

  console.log(response.output_text ?? "No final text returned.");
}

runPromptWithScanner();
