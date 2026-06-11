import { runPaperTraderCycle } from "./paperTrader.js";
import { readAutomationLane } from "./config.js";

async function main(): Promise<void> {
  const promptArg = process.argv.find((value) => value.startsWith("--prompt="));
  const modeArg = process.argv.find((value) => value.startsWith("--mode="));
  const prompt = promptArg ? promptArg.slice("--prompt=".length) : undefined;
  const mode = readAutomationLane(modeArg ? modeArg.slice("--mode=".length) : undefined) ?? "paper";
  const dryRun = process.argv.includes("--dry-run");
  const result = await runPaperTraderCycle({
    mode,
    ...(prompt ? { prompt } : {}),
    dryRun,
    source: "cli",
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
