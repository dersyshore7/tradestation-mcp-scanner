import { DEFAULT_SCAN_PROMPT } from "../src/config/defaultScanPrompt.js";

type VercelResponseLike = {
  status: (code: number) => VercelResponseLike;
  json: (body: unknown) => void;
};

export default async function handler(_req: unknown, res: VercelResponseLike): Promise<void> {
  res.status(200).json({ defaultScanPrompt: DEFAULT_SCAN_PROMPT });
}
