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
  console.log(JSON.stringify(diagnostics, null, 2));
}

runDebug().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
