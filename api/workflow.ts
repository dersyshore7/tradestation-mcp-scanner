import { runScan, type ScanInput } from "../src/app/runScan.js";
import { constructTradeCard } from "../src/app/runTradeConstruction.js";
import { DEFAULT_SCAN_PROMPT } from "../src/config/defaultScanPrompt.js";

type VercelRequestLike = {
  method?: string;
  body?: unknown;
};

type VercelResponseLike = {
  status: (code: number) => VercelResponseLike;
  json: (body: unknown) => void;
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
  return message.includes("Chart-anchored levels do not support a clean 2:1 structure");
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
    res.status(404).json({ error: "Use POST /api/workflow" });
    return;
  }

  try {
    const scanInput = normalizeInput(req.body);
    const scanResult = await runScan(scanInput);
    const telemetry = scanResult.telemetry ?? null;

    if (
      scanResult.conclusion !== "confirmed" ||
      !scanResult.ticker ||
      !scanResult.direction ||
      !scanResult.confidence
    ) {
      res.status(200).json({
        prompt: scanInput.prompt,
        scan: scanResult,
        tradeCard: null,
        telemetry,
      });
      return;
    }

    try {
      const tradeCard = await constructTradeCard({
        prompt: `build trade ${scanResult.ticker}`,
        confirmedDirection: scanResult.direction,
        confirmedConfidence: scanResult.confidence,
      });

      res.status(200).json({
        prompt: scanInput.prompt,
        scan: scanResult,
        tradeCard,
        telemetry,
      });
      return;
    } catch (error) {
      if (!isChartAnchoredTwoToOneBlocker(error)) {
        throw error;
      }

      const blockerMessage = readErrorMessage(error);
      const telemetryWithTradeBlock = {
        ...(telemetry ?? {}),
        tradeCardBlock: {
          blocked: true,
          reason: blockerMessage,
          scanReasoning: scanResult.reason,
        },
      };

      res.status(200).json({
        prompt: scanInput.prompt,
        scan: {
          ...scanResult,
          conclusion: "no_trade_today",
          reason: blockerMessage,
        },
        tradeCard: null,
        telemetry: telemetryWithTradeBlock,
      });
      return;
    }
  } catch (error) {
    console.error("Failed to run /api/workflow", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Workflow failed.",
    });
  }
}
