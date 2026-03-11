import { runScan, type ScanInput } from "../src/app/runScan.js";
import { runStarterUniverseTelemetryDebug } from "../src/app/runScan.js";
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
    const shouldIncludeStarterUniverseTelemetry = scanResult.conclusion === "no_trade_today";
    const telemetry = shouldIncludeStarterUniverseTelemetry ? await runStarterUniverseTelemetryDebug().catch(() => null) : null;

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
  } catch (error) {
    console.error("Failed to run /api/workflow", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Workflow failed.",
    });
  }
}
