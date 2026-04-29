import { listJournalTradeDetails } from "../journal/repository.js";
import { recommendPolicyAction, trainPolicyModel } from "./policyModel.js";

async function main(): Promise<void> {
  const trades = await listJournalTradeDetails(500);
  const model = trainPolicyModel(trades);

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
    sampleRecommendations,
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
