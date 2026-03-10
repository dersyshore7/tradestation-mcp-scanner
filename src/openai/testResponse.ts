import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenAiClient } from "./client.js";

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
    // Keep this setup beginner-friendly: no .env file is OK if the key is set another way.
  }
}

async function runOpenAiTestResponse(): Promise<void> {
  loadDotEnvFileIfPresent();

  const client = await createOpenAiClient();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: "Say hello from the local OpenAI Responses API test.",
  });

  console.log(response.output_text);
}

runOpenAiTestResponse();
