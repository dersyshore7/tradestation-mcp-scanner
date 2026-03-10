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

  for (const item of diagnostics) {
    console.log(`\n=== ${item.symbol} ===`);
    console.log(`pass=${item.pass} direction=${item.direction ?? "none"} score=${item.score}`);
    console.log(`summary=${item.summary}`);
    console.log(
      `alignment: ${item.diagnostics.alignmentPass ? "PASS" : "FAIL"} | 1D=${item.diagnostics.move1D === null ? "n/a" : `${item.diagnostics.move1D.toFixed(2)}%`} (${item.diagnostics.bias1D}), 1W=${item.diagnostics.move1W === null ? "n/a" : `${item.diagnostics.move1W.toFixed(2)}%`} (${item.diagnostics.bias1W})`,
    );
    console.log(`alignment rule: ${item.diagnostics.alignmentRule}`);
    console.log(`alignment reason: ${item.diagnostics.alignmentReason}`);
    console.log("timeframes:");
    for (const [view, tf] of Object.entries(item.diagnostics.timeframeDiagnostics)) {
      const latestSample = tf.latestParsedBarSample ? JSON.stringify(tf.latestParsedBarSample).slice(0, 180) : "n/a";
      console.log(
        `  - ${view}: target=${tf.requestTarget} status=${tf.status ?? "n/a"} bars=${tf.barCount} parsed(ohlcv)=${tf.parsedOpen ? "Y" : "N"}/${tf.parsedHigh ? "Y" : "N"}/${tf.parsedLow ? "Y" : "N"}/${tf.parsedClose ? "Y" : "N"}/${tf.parsedVolume ? "Y" : "N"}`,
      );
      console.log(`    latest parsed sample: ${latestSample}`);
    }
    console.log(
      `candle: body=${item.diagnostics.candleBodySize === null ? "n/a" : item.diagnostics.candleBodySize.toFixed(2)} range=${item.diagnostics.candleRange === null ? "n/a" : item.diagnostics.candleRange.toFixed(2)} bodyToRange=${item.diagnostics.bodyToRange === null ? "n/a" : item.diagnostics.bodyToRange.toFixed(2)} wickiness=${item.diagnostics.wickiness === null ? "n/a" : item.diagnostics.wickiness.toFixed(2)}`,
    );
    console.log(
      `volume: present=${item.diagnostics.volumeDataPresent} last=${item.diagnostics.lastVolume ?? "n/a"} avg=${item.diagnostics.averageVolume === null ? "n/a" : item.diagnostics.averageVolume.toFixed(2)} ratio=${item.volumeRatio === null ? "n/a" : item.volumeRatio.toFixed(2)}`,
    );
    console.log(`volume computation: ${item.diagnostics.volumeRatioComputation}`);
    console.log(
      `higher timeframe: resistance=${item.diagnostics.resistanceLevel ?? "n/a"} support=${item.diagnostics.supportLevel ?? "n/a"} roomPct=${item.diagnostics.roomPct === null ? "n/a" : `${item.diagnostics.roomPct.toFixed(2)}%`}`,
    );
    console.log("checks:");
    for (const check of item.diagnostics.checks) {
      console.log(`  - ${check.pass ? "PASS" : "FAIL"} ${check.check}: ${check.reason}`);
    }
  }
}

runDebug().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
