import assert from "node:assert/strict";

import { mergeFinalizedAsymmetryIntoFinalistsReviewedDebug } from "./runScan.js";

const staleDebug = [
  {
    symbol: "OXY",
    eligibleForReviewReason: "eligible",
    continuationPass: true,
    continuationReason: "ok",
    confirmationEligible: true,
    confirmationEligibilityReason: "ok",
    preReviewAsymmetryTier: "preferred_2r_or_better" as const,
    preReviewActualRewardRiskRatio: 2.11,
    preReviewInvalLevel: 48.1,
    preReviewInvalReason: "swing low",
    preReviewTargetLevel: 52.9,
    preReviewTargetReason: "resistance",
    preReviewRiskDistance: 1.2,
    preReviewRewardDistance: 2.53,
    directionalRoomTier: "preferred_2r_or_better" as const,
    actualChartAsymmetryTier: "preferred_2r_or_better" as const,
    postConfirmationActualRewardRiskRatio: null,
    postConfirmationAsymmetryTier: "unknown" as const,
    postConfirmationInvalLevel: null,
    postConfirmationTargetLevel: null,
    postConfirmationAsymmetryReason: null,
    asymmetryConsistencyFlag: true,
    asymmetryConsistencyReason:
      "Stage 3 directional room and actual chart-anchored tradable asymmetry are aligned.",
    consistencyWarning: null,
    sourceList: "stage3Passed" as const,
    inStage2Passed: true,
    inStage3Passed: true,
    upstreamConsistencyOk: true,
    upstreamConsistencyWarning: null,
  },
];

const finalizedOutcome = [
  {
    symbol: "OXY",
    candidateBlockedPostConfirmation: true,
    asymmetryDebug: {
      postConfirmationActualRewardRiskRatio: 0.5005,
      postConfirmationAsymmetryTier: "obvious_no_room" as const,
      postConfirmationInvalLevel: 49.4,
      postConfirmationTargetLevel: 49.9,
      postConfirmationAsymmetryReason:
        "Chart-anchored levels do not support minimum tradable asymmetry.",
      asymmetryConsistencyFlag: false,
      asymmetryConsistencyReason:
        "OXY Stage 3 directional room and actual chart-anchored tradable asymmetry diverged between stages; post-review actual reward:risk was 0.50. Prompt 2 confirmation passed, but the downstream trade-card check recalculated weaker chart-anchored asymmetry.",
    },
  },
];

const merged = mergeFinalizedAsymmetryIntoFinalistsReviewedDebug(
  staleDebug,
  finalizedOutcome,
);
const oxy = merged[0];
assert.ok(oxy, "Expected merged OXY debug entry");

assert.equal(oxy.postConfirmationAsymmetryTier, "obvious_no_room");
assert.equal(oxy.asymmetryConsistencyFlag, false);
assert.match(oxy.asymmetryConsistencyReason ?? "", /diverged between stages/i);
assert.doesNotMatch(
  oxy.asymmetryConsistencyReason ?? "",
  /are aligned/i,
);

console.log(
  JSON.stringify(
    {
      symbol: oxy.symbol,
      preReviewActualRewardRiskRatio: oxy.preReviewActualRewardRiskRatio,
      postConfirmationActualRewardRiskRatio:
        oxy.postConfirmationActualRewardRiskRatio,
      postConfirmationAsymmetryTier: oxy.postConfirmationAsymmetryTier,
      asymmetryConsistencyFlag: oxy.asymmetryConsistencyFlag,
      asymmetryConsistencyReason: oxy.asymmetryConsistencyReason,
    },
    null,
    2,
  ),
);
