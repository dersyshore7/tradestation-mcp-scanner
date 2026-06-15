import {
  listJournalTradeDetails,
  recomputeJournalTradeReviewFromExits,
} from "../journal/repository.js";
import type { AccountMode } from "../journal/types.js";
import { buildLearningReviewRepairPlan } from "./learningRepair.js";

function readArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function readMode(): AccountMode | "all" {
  const value = readArgValue("mode")?.trim();
  if (!value || value === "all") {
    return "all";
  }
  if (value === "paper" || value === "live") {
    return value;
  }
  throw new Error("--mode must be paper, live, or all.");
}

function readLimit(): number {
  const raw = readArgValue("limit");
  if (!raw) {
    return 500;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--limit must be a positive number.");
  }
  return Math.floor(parsed);
}

async function main(): Promise<void> {
  const accountMode = readMode();
  const limit = readLimit();
  const apply = process.argv.includes("--apply");
  const trades = await listJournalTradeDetails(limit, {
    status: "closed",
    includeSignalSnapshot: false,
    ...(accountMode === "all" ? {} : { accountMode }),
  });
  const plan = buildLearningReviewRepairPlan(trades, { accountMode });
  const repairable = plan.items.filter((item) => item.reason === "repairable");
  const applied: string[] = [];

  if (apply) {
    for (const item of repairable) {
      await recomputeJournalTradeReviewFromExits(item.tradeId);
      applied.push(item.tradeId);
    }
  }

  console.log(JSON.stringify({
    dryRun: !apply,
    appliedCount: applied.length,
    applied,
    note: apply
      ? "Applied journal-only review recomputation from existing journal exits."
      : "Dry run only. Re-run with --apply to update repairable journal_reviews rows.",
    plan,
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
