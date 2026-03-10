import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runStage3DebugForStarterUniverse } from "./runScan.js";

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
  const diagnostics = await runStage3DebugForStarterUniverse();

  const passed = diagnostics.filter((item) => item.pass);
  console.log(`Stage 3 review summary (${diagnostics.length} symbols, ${passed.length} passed)`);

  for (const item of diagnostics) {
    const direction = item.direction ?? "none";
    const move = `${item.movePct.toFixed(2)}%`;
    const volume = item.volumeRatio === null ? "n/a" : item.volumeRatio.toFixed(2);
    console.log(
      `${item.symbol}: ${item.pass ? "PASS" : "FAIL"} | dir=${direction} | score=${item.score} | move=${move} | vol=${volume} | ${item.summary}`,
    );
  }
}

runDebug().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
