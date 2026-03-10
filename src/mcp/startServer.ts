import { createServer } from "node:http";
import { fail, handleRpc, type JsonRpcRequest } from "./rpc.js";

const port = Number(process.env.MCP_PORT ?? 3001);

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Use POST /mcp" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });

  req.on("end", async () => {
    let request: JsonRpcRequest;

    try {
      request = JSON.parse(body) as JsonRpcRequest;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(fail(null, -32700, "Invalid JSON body.")));
      return;
    }

    const response = await handleRpc(request);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
});

server.listen(port, () => {
  console.log(`MCP server listening on http://localhost:${port}/mcp`);
});
