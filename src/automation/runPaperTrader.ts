import { runPaperTraderCycle } from "./paperTrader.js";

async function main(): Promise<void> {
  const promptArg = process.argv.find((value) => value.startsWith("--prompt="));
  const prompt = promptArg ? promptArg.slice("--prompt=".length) : undefined;
  const dryRun = process.argv.includes("--dry-run");
  const result = await runPaperTraderCycle({
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
