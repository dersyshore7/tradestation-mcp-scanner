import { listJournalTradeDetails } from "../journal/repository.js";
import { summarizeEntryRewardModel, trainEntryRewardModel } from "./entryRewardModel.js";
import { recommendPolicyAction, trainPolicyModel } from "./policyModel.js";

async function main(): Promise<void> {
  const includeSnapshots = process.argv.includes("--with-snapshots");
  const trades = await listJournalTradeDetails(300, {
    accountMode: "paper",
    status: "closed",
    includeSignalSnapshot: includeSnapshots,
  });
  const model = trainPolicyModel(trades);
  const entryModel = trainEntryRewardModel(trades);

  const sampleRecommendations = [
    recommendPolicyAction(model, {
      direction: "CALL",
      setupType: "bullish_continuation",
      confidenceBucket: "75-84",
      progressToTargetPct: 55,
      optionReturnPct: 18,
      dteAtEntry: 19,
    }),
    recommendPolicyAction(model, {
      direction: "PUT",
      setupType: "bearish_continuation",
      confidenceBucket: "75-84",
      progressToTargetPct: 40,
      optionReturnPct: -8,
      dteAtEntry: 14,
    }),
  ];

  console.log(JSON.stringify({
    generatedAt: model.generatedAt,
    closedTradeCount: model.closedTradeCount,
    experienceCount: model.experienceCount,
    learnedContextCount: Object.keys(model.buckets).length,
    entryRewardModel: {
      generatedAt: entryModel.generatedAt,
      closedTradeCount: entryModel.closedTradeCount,
      experienceCount: entryModel.experienceCount,
      learnedContextCount: Object.keys(entryModel.buckets).length,
      summary: summarizeEntryRewardModel(entryModel),
      featureCoverage: entryModel.featureCoverage,
      topContexts: entryModel.topContexts,
      weakContexts: entryModel.weakContexts,
    },
    sampleRecommendations,
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
