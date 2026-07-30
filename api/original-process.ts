import { runOriginalProcessStep } from "../src/app/originalProcess.js";
import { requireApiBearerAuth } from "./auth.js";
import { sendError, sendJson, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (!requireApiBearerAuth(req, res)) {
    return;
  }
  if (req.method !== "POST") {
    sendError(res, 404, "Use POST /api/original-process");
    return;
  }

  try {
    const result = await runOriginalProcessStep(req.body ?? {});
    sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Original Process workflow failed.";
    console.error("Failed to run /api/original-process", error);
    sendError(res, 500, message);
  }
}
