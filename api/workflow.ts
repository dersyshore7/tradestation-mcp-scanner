import {
  extractFinalizedTradeGeometryFromTelemetry,
  mergeFinalizedAsymmetryIntoFinalistsReviewedDebug,
  runScan,
  type ScanInput,
  type StarterUniverseTelemetry,
} from "../src/app/runScan.js";
import { buildWorkflowPresentationSummary } from "../src/app/resultPresentation.js";
import { constructTradeCard } from "../src/app/runTradeConstruction.js";
import { CHART_ANCHORED_TWO_TO_ONE_FAILURE } from "../src/app/chartAnchoredTradability.js";
import { DEFAULT_SCAN_PROMPT } from "../src/config/defaultScanPrompt.js";
import { createTradeRecommendation } from "../src/recommendations/repository.js";

type VercelRequestLike = {
  method?: string;
  body?: unknown;
};

type VercelResponseLike = {
  status: (code: number) => VercelResponseLike;
  json: (body: unknown) => void;
  setHeader?: (name: string, value: string) => void;
};

type WorkflowRequestBody = {
  prompt?: string;
  excludedTickers?: string[];
};

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isChartAnchoredTwoToOneBlocker(error: unknown): boolean {
  const message = readErrorMessage(error);
  return message.includes(CHART_ANCHORED_TWO_TO_ONE_FAILURE);
}

function buildScanRunId(): string {
  return `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toSerializableJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sendJson(res: VercelResponseLike, statusCode: number, body: unknown): void {
  res.setHeader?.("content-type", "application/json; charset=utf-8");
  res.status(statusCode).json(toSerializableJsonValue(body));
}

function sendWorkflowError(
  res: VercelResponseLike,
  statusCode: number,
  message: string,
  details?: unknown,
): void {
  sendJson(res, statusCode, {
    error: true,
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function normalizeInput(body: unknown): ScanInput {
  const payload = (body ?? {}) as WorkflowRequestBody;
  const prompt = typeof payload.prompt === "string" && payload.prompt.trim().length > 0 ? payload.prompt.trim() : DEFAULT_SCAN_PROMPT;
  const excludedTickers = Array.isArray(payload.excludedTickers)
    ? payload.excludedTickers.filter((item): item is string => typeof item === "string")
    : [];

  return { prompt, excludedTickers };
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "POST") {
    sendWorkflowError(res, 404, "Use POST /api/workflow");
    return;
  }

  try {
    const scanInput = normalizeInput(req.body);
    const scanRunId = buildScanRunId();
    const scanResult = await runScan(scanInput);
    const telemetry = scanResult.telemetry ?? null;

    if (
      scanResult.conclusion !== "confirmed" ||
      !scanResult.ticker ||
      !scanResult.direction ||
      !scanResult.confidence
    ) {
      sendJson(res, 200, {
        scan_run_id: scanRunId,
        prompt: scanInput.prompt,
        scan: scanResult,
        tradeCard: null,
        telemetry,
        presentationSummary: buildWorkflowPresentationSummary({
          scan: scanResult,
          telemetry,
          tradeCard: null,
        }),
      });
      return;
    }

    try {
      const finalizedTradeGeometry = extractFinalizedTradeGeometryFromTelemetry(
        telemetry,
        scanResult.ticker,
      );
      const tradeCard = await constructTradeCard({
        prompt: `build trade ${scanResult.ticker}`,
        confirmedDirection: scanResult.direction,
        confirmedConfidence: scanResult.confidence,
        ...(finalizedTradeGeometry ? { finalizedTradeGeometry } : {}),
      });
      const presentationSummary = buildWorkflowPresentationSummary({
        scan: scanResult,
        telemetry,
        tradeCard,
      });
      const signalSnapshotJson = {
        scan: scanResult,
        telemetry,
        tradeCard,
        presentationSummary,
      };
      let tradeRecommendation = null;

      try {
        tradeRecommendation = await createTradeRecommendation({
          scan_run_id: scanRunId,
          prompt: scanInput.prompt,
          planned_trade: tradeCard.plannedJournalFields,
          signal_snapshot_json: signalSnapshotJson,
        });
      } catch (recommendationError) {
        console.warn("Failed to persist trade recommendation history.", recommendationError);
      }

      sendJson(res, 200, {
        scan_run_id: scanRunId,
        prompt: scanInput.prompt,
        scan: scanResult,
        tradeCard,
        journalPlannedTrade: tradeCard.plannedJournalFields,
        tradeRecommendation,
        telemetry,
        presentationSummary,
      });
      return;
    } catch (error) {
      const blockerMessage = readErrorMessage(error);
      const blockedTicker = scanResult.ticker;
      const reviewedFinalistOutcomes = Array.isArray(telemetry?.reviewedFinalistOutcomes)
        ? telemetry.reviewedFinalistOutcomes.map((item: any) =>
            item?.symbol === blockedTicker
              ? {
                  ...item,
                  candidateBlockedPostConfirmation: true,
                  blockedConfirmationReason: blockerMessage,
                  tierAbandonedAfterBlock: true,
                  scanContinuedAfterBlock: false,
                  survivedFinalSelection: false,
                  conclusion: "no_trade_today",
                  reason: blockerMessage,
                }
              : item,
          )
        : [];
      const telemetryWithTradeBlock: (StarterUniverseTelemetry & { tradeCardBlock: Record<string, unknown> }) | null = telemetry
        ? {
            ...telemetry,
            finalSelectedSymbol: null,
            winningTier: null,
            finalSelectionSourceTier: null,
            finalOutcomeSource: "tier_blocked_post_confirmation",
            reviewedFinalistOutcomes,
            bestRejectedCandidates: reviewedFinalistOutcomes
              .filter((item: any) => item?.conclusion !== "confirmed")
              .map((item: any) => ({
                symbol: item.symbol,
                tier: item.tier,
                tierLabel: item.tierLabel,
                rejectionReasons: item.confirmationFailureReasons,
              })),
            bestReviewedFinalistsAcrossTiers: reviewedFinalistOutcomes
              .filter((item: any) => item?.survivedFinalSelection)
              .map((item: any) => item.symbol),
            crossTierFinalistSummary: null,
            tradeCardBlock: {
              blocked: true,
              reason: blockerMessage,
              scanReasoning: scanResult.reason,
            },
          }
        : null;
      const telemetryForResponse = telemetryWithTradeBlock && Array.isArray(telemetry?.finalistsReviewedDebug)
        ? {
            ...telemetryWithTradeBlock,
            finalistsReviewedDebug: mergeFinalizedAsymmetryIntoFinalistsReviewedDebug(
              telemetry.finalistsReviewedDebug,
              reviewedFinalistOutcomes,
            ),
          }
        : telemetryWithTradeBlock;

      if (isChartAnchoredTwoToOneBlocker(error)) {
        console.warn("Unexpected trade-card reward:risk blocker after confirmation; returning no_trade_today for safety.");
      }

      const blockedScanResult = {
        ...scanResult,
        conclusion: "no_trade_today" as const,
        reason: blockerMessage,
      };

      sendJson(res, 200, {
        scan_run_id: scanRunId,
        prompt: scanInput.prompt,
        scan: blockedScanResult,
        tradeCard: null,
        telemetry: telemetryForResponse,
        presentationSummary: buildWorkflowPresentationSummary({
          scan: blockedScanResult,
          telemetry: telemetryForResponse,
          tradeCard: null,
        }),
      });
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow failed.";
    console.error("Failed to run /api/workflow", error);

    try {
      sendWorkflowError(res, 500, message, {
        stage: "workflow_handler",
      });
    } catch (responseError) {
      console.error("Failed to send JSON error response for /api/workflow", responseError);
      sendWorkflowError(res, 500, "Workflow failed.", {
        stage: "workflow_error_fallback",
      });
    }
  }
}
