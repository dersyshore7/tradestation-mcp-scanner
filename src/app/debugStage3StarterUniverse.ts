import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runStage3DebugForStarterUniverse, runStarterUniverseTelemetryDebug } from "./runScan.js";

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

const MAX_STAGE3_LINES = Number(process.env.STAGE3_DEBUG_MAX_LINES ?? "20");

async function runDebug(): Promise<void> {
  loadDotEnvFileIfPresent();
  const telemetry = await runStarterUniverseTelemetryDebug();
  const diagnostics = await runStage3DebugForStarterUniverse();

  console.log("Stage pass counts:");
  console.log(JSON.stringify(telemetry.stageCounts, null, 2));

  console.log("Rejection summaries:");
  console.log(JSON.stringify(telemetry.rejectionSummaries, null, 2));

  console.log("Top Stage 3 near misses:");
  if (telemetry.nearMisses.length === 0) {
    console.log("(none)");
  } else {
    for (const miss of telemetry.nearMisses) {
      console.log(
        `${miss.symbol}: dir=${miss.direction} | score=${miss.score} | fail=${miss.failReasons.join(", ")}`,
      );
    }
  }

  const passed = diagnostics.filter((item) => item.pass);
  const failed = diagnostics.filter((item) => !item.pass);
  const failSummary = new Map<string, number>();
  for (const item of failed) {
    const key = item.summary;
    failSummary.set(key, (failSummary.get(key) ?? 0) + 1);
  }

  console.log(`Stage 3 review summary (${diagnostics.length} symbols, ${passed.length} passed, ${failed.length} failed)`);
  if (failSummary.size > 0) {
    console.log("Top Stage 3 fail summaries:");
    for (const [summary, count] of [...failSummary.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`${count}x ${summary}`);
    }
  }

  const displayedDiagnostics = diagnostics.slice(0, Math.max(0, MAX_STAGE3_LINES));
  for (const item of displayedDiagnostics) {
    const direction = item.direction ?? "none";
    const move = `${item.movePct.toFixed(2)}%`;
    const volume = item.volumeRatio === null ? "n/a" : item.volumeRatio.toFixed(2);
    console.log(
      `${item.symbol}: ${item.pass ? "PASS" : "FAIL"} | dir=${direction} | score=${item.score} | move=${move} | vol=${volume} | ${item.summary}`,
    );
  }

  if (diagnostics.length > displayedDiagnostics.length) {
    console.log(`... truncated ${diagnostics.length - displayedDiagnostics.length} symbol rows (set STAGE3_DEBUG_MAX_LINES to adjust).`);
  }
}

runDebug().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
