import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ScanConfidence } from "../scanner/scoring.js";
import { constructTradeCard, type TradeConstructionInput } from "./runTradeConstruction.js";

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
    // No .env file is fine if env vars are already set.
  }
}

async function runDebug(): Promise<void> {
  loadDotEnvFileIfPresent();

  const symbol = (process.env.SYMBOL ?? process.argv[2] ?? "OXY").toUpperCase();
  const input: TradeConstructionInput = {
    prompt: `construct trade ${symbol}`,
  };

  const direction = process.env.CONFIRMED_DIRECTION;
  if (direction === "bullish" || direction === "bearish") {
    input.confirmedDirection = direction;
  }

  const confidence = process.env.CONFIRMED_CONFIDENCE;
  const allowedConfidence: ScanConfidence[] = ["65-74", "75-84", "85-92", "93-97"];
  if (confidence && allowedConfidence.includes(confidence as ScanConfidence)) {
    input.confirmedConfidence = confidence as ScanConfidence;
  }

  const result = await constructTradeCard(input);
  console.log(JSON.stringify({ input, result }, null, 2));
}

runDebug().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
