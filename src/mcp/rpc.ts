import { callScanTool, callTradeConstructionTool, scanToolDefinition, tradeConstructionToolDefinition } from "./server.js";

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

export async function handleRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
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
    return ok(id, { tools: [scanToolDefinition, tradeConstructionToolDefinition] });
  }

  if (request.method === "tools/call") {
    const params = request.params as { name?: string; arguments?: unknown } | undefined;

    if (!params || typeof params.name !== "string") {
      return fail(id, -32602, "Unknown tool.");
    }

    try {
      if (params.name === "scan_prompt_to_best_ticker") {
        const result = await callScanTool(params.arguments ?? {});
        return ok(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          structuredContent: result,
        });
      }

      if (params.name === "construct_trade_card") {
        const result = await callTradeConstructionTool(params.arguments ?? {});
        const userCard = {
          Ticker: result.ticker,
          Direction: result.direction,
          Confidence: result.confidence,
          Buy: result.buy,
          "Invalidation Exit": result.invalidationExit,
          "Take-Profit Exit": result.takeProfitExit,
          "Time Exit": result.timeExit,
          "R:R Math": result.rrMath,
          Rationale: result.rationale,
        };

        return ok(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(userCard),
            },
          ],
          structuredContent: userCard,
        });
      }

      return fail(id, -32602, "Unknown tool. Expected scan_prompt_to_best_ticker or construct_trade_card.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool call failed.";
      return fail(id, -32602, message);
    }
  }

  return fail(id, -32601, `Unsupported method: ${request.method}`);
}
