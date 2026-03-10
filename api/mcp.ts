import { fail, handleRpc, type JsonRpcRequest } from "../src/mcp/rpc.ts";

type VercelRequestLike = {
  method?: string;
  body?: unknown;
};

type VercelResponseLike = {
  status: (code: number) => VercelResponseLike;
  json: (body: unknown) => void;
};

export default function handler(req: VercelRequestLike, res: VercelResponseLike): void {
  if (req.method !== "POST") {
    res.status(404).json({ error: "Use POST /api/mcp" });
    return;
  }

  const requestBody = req.body;
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
    res.status(400).json(fail(null, -32700, "Invalid JSON body."));
    return;
  }

  const response = handleRpc(requestBody as JsonRpcRequest);
  res.status(200).json(response);
}
