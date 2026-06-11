import { listJournalTradeDetails } from "../journal/repository.js";
import { summarizeEntryRewardModel, trainEntryRewardModel } from "./entryRewardModel.js";
import { buildPaperLearningTradeSet } from "./paperLearningCutoff.js";
import { recommendPolicyAction, trainPolicyModel } from "./policyModel.js";

async function main(): Promise<void> {
  const includeSnapshots = !process.argv.includes("--without-snapshots");
  const trades = await listJournalTradeDetails(300, {
    status: "closed",
    includeSignalSnapshot: includeSnapshots,
  });
  const learning = buildPaperLearningTradeSet(trades);
  const model = trainPolicyModel(learning.trades);
  const entryModel = trainEntryRewardModel(learning.trades);

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
    learningStartAt: learning.learningStartAt,
    loadedTradeCount: trades.length,
    excludedLearningTrades: learning.excludedLearningTrades,
    closedTradeCount: model.closedTradeCount,
    sourceCounts: model.sourceCounts,
    experienceCount: model.experienceCount,
    learnedContextCount: Object.keys(model.buckets).length,
    entryRewardModel: {
      generatedAt: entryModel.generatedAt,
      closedTradeCount: entryModel.closedTradeCount,
      sourceCounts: entryModel.sourceCounts,
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
