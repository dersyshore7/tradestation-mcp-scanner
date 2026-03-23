import type { ScanResult, StarterUniverseTelemetry } from "./runScan.js";
import { extractFinalizedTradeGeometryFromTelemetry } from "./runScan.js";
import type { TradeConstructionResult } from "./runTradeConstruction.js";

type ReviewLadderItem = {
  symbol: string;
  stage3RankScore: number;
  outcome: string;
  detail: string;
};

type PresentationSummary = {
  outcomeLabel: string;
  reviewLadder: ReviewLadderItem[];
  whyThisWon: string;
  conciseReasoning: string;
  finalChartGeometry: {
    direction: string;
    reference: string;
    invalidation: string;
    target: string;
    finalChartRewardRisk: string;
    structure: string;
  } | null;
  tradeCard: {
    optionChosen: string;
    contractCapital: string;
    expectedTiming: string;
    invalidationExit: string;
    takeProfitExit: string;
    timeExit: string;
    optionValueApproximation: string;
    rationale: string;
  } | null;
};

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function buildOutcomeLabel(scan: ScanResult, telemetry: StarterUniverseTelemetry | null | undefined, tradeCard: TradeConstructionResult | null): string {
  if (scan.conclusion === "confirmed" && tradeCard) {
    return "confirmed trade setup";
  }
  const blockedAfterConfirmation = telemetry?.reviewedFinalistOutcomes?.some(
    (item) => item.candidateBlockedPostConfirmation,
  );
  if (blockedAfterConfirmation) {
    return "no trade today — blocked after confirmation";
  }
  if (scan.conclusion === "rejected") {
    return "rejected setup";
  }
  return "no trade today";
}

function buildReviewLadder(telemetry: StarterUniverseTelemetry | null | undefined, selectedSymbol: string | null): ReviewLadderItem[] {
  const reviewed = telemetry?.reviewedFinalistOutcomes ?? [];
  const rankingOrder = telemetry?.finalRankingDebug ?? [];
  const reviewedBySymbol = new Map(reviewed.map((item) => [item.symbol, item]));

  return rankingOrder
    .filter((item) => reviewedBySymbol.has(item.symbol))
    .map((item) => {
      const reviewedItem = reviewedBySymbol.get(item.symbol)!;
      const outcome = selectedSymbol && reviewedItem.symbol === selectedSymbol
        ? "final selected trade"
        : reviewedItem.candidateBlockedPostConfirmation
          ? "blocked after confirmation"
          : reviewedItem.candidateConfirmedInPrompt2
            ? "confirmed in Prompt 2, not selected"
            : "rejected in confirmation";
      const detail = reviewedItem.candidateBlockedPostConfirmation
        ? reviewedItem.blockedConfirmationReason ?? reviewedItem.reason
        : reviewedItem.candidateConfirmedInPrompt2 && reviewedItem.symbol !== selectedSymbol
          ? reviewedItem.reason
          : reviewedItem.confirmationFailureReasons.join("; ") || reviewedItem.reason;
      return {
        symbol: item.symbol,
        stage3RankScore: reviewedItem.rankingScore,
        outcome,
        detail,
      };
    });
}

function buildWhyThisWon(scan: ScanResult, telemetry: StarterUniverseTelemetry | null | undefined): string {
  const selectedSymbol = telemetry?.finalSelectedSymbol ?? null;
  const topRankedSymbol = telemetry?.topRankedSymbol ?? null;
  if (!selectedSymbol) {
    if (telemetry?.reviewedFinalistOutcomes?.some((item) => item.candidateBlockedPostConfirmation)) {
      return "The top-ranked review sequence reached confirmation, but no candidate survived the final tradability step.";
    }
    return scan.reason;
  }
  if (!topRankedSymbol || topRankedSymbol === selectedSymbol) {
    return `${selectedSymbol} was the top-ranked finalist and also the first reviewed candidate to survive confirmation and final trade-card validation.`;
  }
  return `${selectedSymbol} was not the top-ranked candidate, but it was the first ranked finalist that survived confirmation and final trade-card validation after ${topRankedSymbol} was blocked or rejected earlier in the review ladder.`;
}

function buildConciseReasoning(scan: ScanResult, tradeCard: TradeConstructionResult | null): string {
  if (tradeCard && tradeCard.rationale.trim() === scan.reason.trim()) {
    return scan.reason;
  }
  if (tradeCard) {
    return `${scan.reason} ${tradeCard.rationale}`.trim();
  }
  return scan.reason;
}

function buildFinalChartGeometry(scan: ScanResult, telemetry: StarterUniverseTelemetry | null | undefined) {
  const geometry = extractFinalizedTradeGeometryFromTelemetry(telemetry, scan.ticker);
  if (!geometry || !scan.direction) {
    return null;
  }

  return {
    direction: scan.direction,
    reference: formatNumber(geometry.referencePrice),
    invalidation: `${formatNumber(geometry.invalidationLevel)} (${geometry.invalidationReason})`,
    target: `${formatNumber(geometry.targetLevel)} (${geometry.targetReason})`,
    finalChartRewardRisk: `${formatNumber(geometry.rewardRiskRatio)}:1`,
    structure: geometry.geometryReason,
  };
}

function extractOptionValueApproximation(tradeCard: TradeConstructionResult | null): string {
  if (!tradeCard) {
    return "";
  }
  const marker = "Option approximation:";
  const start = tradeCard.rrMath.indexOf(marker);
  return start >= 0 ? tradeCard.rrMath.slice(start).trim() : tradeCard.rrMath;
}

export function buildWorkflowPresentationSummary(params: {
  scan: ScanResult;
  telemetry?: StarterUniverseTelemetry | null;
  tradeCard?: TradeConstructionResult | null;
}): PresentationSummary {
  const telemetry = params.telemetry ?? params.scan.telemetry ?? null;
  const tradeCard = params.tradeCard ?? null;

  return {
    outcomeLabel: buildOutcomeLabel(params.scan, telemetry, tradeCard),
    reviewLadder: buildReviewLadder(telemetry, telemetry?.finalSelectedSymbol ?? null),
    whyThisWon: buildWhyThisWon(params.scan, telemetry),
    conciseReasoning: buildConciseReasoning(params.scan, tradeCard),
    finalChartGeometry: buildFinalChartGeometry(params.scan, telemetry),
    tradeCard: tradeCard
      ? {
          optionChosen: `${tradeCard.ticker} ${tradeCard.direction} option structure via ${tradeCard.buy}`,
          contractCapital: tradeCard.buy,
          expectedTiming: tradeCard.expectedTiming,
          invalidationExit: tradeCard.invalidationExit,
          takeProfitExit: tradeCard.takeProfitExit,
          timeExit: tradeCard.timeExit,
          optionValueApproximation: extractOptionValueApproximation(tradeCard),
          rationale: tradeCard.rationale,
        }
      : null,
  };
}
