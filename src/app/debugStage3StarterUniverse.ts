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

const stage3MaxLinesRaw = process.env.STAGE3_DEBUG_MAX_LINES;
const stage3MaxLines = stage3MaxLinesRaw ? Number(stage3MaxLinesRaw) : null;
const hasStage3MaxLines = stage3MaxLines !== null && Number.isFinite(stage3MaxLines) && stage3MaxLines >= 0;

async function runDebug(): Promise<void> {
  loadDotEnvFileIfPresent();
  const telemetry = await runStarterUniverseTelemetryDebug();
  const diagnostics = await runStage3DebugForStarterUniverse();

  console.log("Stage pass counts:");
  console.log(JSON.stringify(telemetry.stageCounts, null, 2));

  const countMismatches: string[] = [];
  const expectedStage1Entered = telemetry.stageSymbols.stage1Entered.length;
  if (telemetry.stageCounts.stage1Entered !== expectedStage1Entered) {
    countMismatches.push(`stage1Entered count=${telemetry.stageCounts.stage1Entered} symbols=${expectedStage1Entered}`);
  }

  const expectedStage1Passed = telemetry.stageSymbols.stage1Passed.length;
  if (telemetry.stageCounts.stage1Passed !== expectedStage1Passed) {
    countMismatches.push(`stage1Passed count=${telemetry.stageCounts.stage1Passed} symbols=${expectedStage1Passed}`);
  }

  const expectedStage2Passed = telemetry.stageSymbols.stage2Passed.length;
  if (telemetry.stageCounts.stage2Passed !== expectedStage2Passed) {
    countMismatches.push(`stage2Passed count=${telemetry.stageCounts.stage2Passed} symbols=${expectedStage2Passed}`);
  }

  const expectedStage3Passed = telemetry.stageSymbols.stage3Passed.length;
  if (telemetry.stageCounts.stage3Passed !== expectedStage3Passed) {
    countMismatches.push(`stage3Passed count=${telemetry.stageCounts.stage3Passed} symbols=${expectedStage3Passed}`);
  }

  const expectedFinalRanking = telemetry.stageSymbols.finalRanking.length;
  if (telemetry.stageCounts.finalRanking !== expectedFinalRanking) {
    countMismatches.push(`finalRanking count=${telemetry.stageCounts.finalRanking} symbols=${expectedFinalRanking}`);
  }

  const stage2Universe = new Set(telemetry.stageSymbols.stage2Passed);
  const diagnosticsStage3Passed = diagnostics.filter((item) => stage2Universe.has(item.symbol) && item.pass).length;
  if (telemetry.stageCounts.stage3Passed !== diagnosticsStage3Passed) {
    countMismatches.push(`stage3Passed telemetry=${telemetry.stageCounts.stage3Passed} diagnostics=${diagnosticsStage3Passed}`);
  }

  if (countMismatches.length > 0) {
    console.log("Count mismatches detected:");
    for (const mismatch of countMismatches) {
      console.log(`- ${mismatch}`);
    }
  } else {
    console.log("Count consistency: OK");
  }

  console.log("Rejection summaries:");
  console.log(JSON.stringify(telemetry.rejectionSummaries, null, 2));

  console.log("Top Stage 3 near misses:");
  if (telemetry.nearMisses.length === 0) {
    console.log("(none)");
  } else {
    for (const miss of telemetry.nearMisses) {
      const room = miss.roomToTargetDiagnostics;
      const roomDetail = room
        ? ` | 2R ref=${room.referencePrice.toFixed(2)} dir=${room.direction} level=${room.levelUsed === null ? "n/a" : room.levelUsed.toFixed(2)} room=${room.roomPct === null ? "n/a" : `${room.roomPct.toFixed(2)}%`} reason=${room.insufficientRoomReason}`
        : "";
      const hardFail = miss.hardFailReasons.length > 0 ? miss.hardFailReasons.join(", ") : "none";
      const softIssues = miss.softIssueReasons.length > 0 ? miss.softIssueReasons.join(", ") : "none";
      const infoIssues = miss.infoReasons.length > 0 ? miss.infoReasons.join(", ") : "none";
      console.log(
        `${miss.symbol}: dir=${miss.direction} | score=${miss.score} | hardFail=${hardFail} | softIssues=${softIssues} | info=${infoIssues}${roomDetail}`,
      );
    }
  }

  const passed = diagnostics.filter((item) => item.pass);
  const failed = diagnostics.filter((item) => !item.pass);
  const stage2PassedSymbols = new Set(telemetry.stageSymbols.stage2Passed);
  const stage3PassedSymbols = new Set(telemetry.stageSymbols.stage3Passed);
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

  console.log("Stage 3 passed symbols:");
  if (telemetry.finalRankingDebug.length === 0) {
    console.log("(none)");
  } else {
    for (const item of telemetry.finalRankingDebug) {
      const score = item.score === null ? "n/a" : item.score.toFixed(2);
      console.log(
        `${item.symbol}: dir=${item.direction} | score=${score} | enteredFinalRanking=${item.enteredFinalRanking} | topRankedCandidate=${item.topRankedCandidate} | confirmedFinalSelection=${item.confirmedFinalSelection} | reason=${item.reason} | inputs=${JSON.stringify(item.scoreInputs)}`,
      );
    }
  }

  console.log("Stage 3 passed but not top ranked:");
  const notSelected = telemetry.finalRankingDebug.filter((item) => !item.topRankedCandidate);
  if (notSelected.length === 0) {
    console.log("(none)");
  } else {
    for (const item of notSelected) {
      const score = item.score === null ? "n/a" : item.score.toFixed(2);
      console.log(`${item.symbol}: score=${score} | reason=${item.reason}`);
    }
  }

  const displayedDiagnostics = hasStage3MaxLines
    ? diagnostics.slice(0, Math.max(0, Math.floor(stage3MaxLines ?? 0)))
    : diagnostics;
  const summaryPassSymbols = new Set<string>();

  for (const item of displayedDiagnostics) {
    const passInSourceOfTruth = stage3PassedSymbols.has(item.symbol);
    const passLabel = passInSourceOfTruth ? "PASS" : "FAIL";
    const direction = item.direction ?? "none";
    const move = `${item.movePct.toFixed(2)}%`;
    const volume = item.volumeRatio === null ? "n/a" : item.volumeRatio.toFixed(2);
    const stage2Note = stage2PassedSymbols.has(item.symbol) ? "" : " | note=not in Stage 2 passed set";
    if (passInSourceOfTruth) {
      summaryPassSymbols.add(item.symbol);
    }

    console.log(
      `${item.symbol}: ${passLabel} | dir=${direction} | score=${item.score} | move=${move} | vol=${volume} | ${item.summary}${stage2Note}`,
    );
  }

  const passSummaryMismatches = [...summaryPassSymbols].filter((symbol) => !stage3PassedSymbols.has(symbol));
  if (passSummaryMismatches.length > 0) {
    console.log(`DEBUG ASSERTION FAILED: per-symbol PASS missing from Stage 3 passed symbols list: ${passSummaryMismatches.join(", ")}`);
  }

  if (hasStage3MaxLines && diagnostics.length > displayedDiagnostics.length) {
    console.log(`... truncated ${diagnostics.length - displayedDiagnostics.length} symbol rows (set STAGE3_DEBUG_MAX_LINES to adjust).`);
  }
}

runDebug().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
