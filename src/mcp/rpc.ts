import { callScanTool, scanToolDefinition } from "./server.js";

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function handleRpc(request: JsonRpcRequest): JsonRpcResponse {
  const id = request.id ?? null;

  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return fail(id, -32600, "Invalid JSON-RPC request.");
  }

  if (request.method === "initialize") {
    return ok(id, {
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "tradestation-mcp-scanner",
        version: "0.1.0",
      },
      capabilities: {
        tools: {},
      },
    });
  }

  if (request.method === "tools/list") {
    return ok(id, { tools: [scanToolDefinition] });
  }

  if (request.method === "tools/call") {
    const params = request.params as { name?: string; arguments?: unknown } | undefined;

    if (!params || params.name !== "scan_prompt_to_best_ticker") {
      return fail(id, -32602, "Unknown tool. Expected scan_prompt_to_best_ticker.");
    }

    try {
      const result = callScanTool(params.arguments ?? {});
      return ok(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
        structuredContent: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool call failed.";
      return fail(id, -32602, message);
    }
  }

  return fail(id, -32601, `Unsupported method: ${request.method}`);
}
