import { DEFAULT_SCAN_PROMPT } from "../src/config/defaultScanPrompt.js";
import { requireApiBearerAuth } from "./auth.js";
import type { VercelRequestLike, VercelResponseLike } from "./journal/shared.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (!requireApiBearerAuth(req, res)) {
    return;
  }
  res.status(200).json({ defaultScanPrompt: DEFAULT_SCAN_PROMPT });
}
