# tradestation-mcp-scanner

A very small beginner-friendly MCP scanner starter in TypeScript.

## What the MCP server does now

This project now runs a **minimal remote HTTP MCP server**.

It exposes exactly one tool:

- `scan_prompt_to_best_ticker`

That tool uses the existing fake scanner logic in `src/app/runScan.ts` (no TradeStation logic yet, no deployment setup yet).

### Tool input

```json
{
  "prompt": "string",
  "excludedTickers": ["string"]
}
```

`excludedTickers` is optional.

### Tool output

```json
{
  "ticker": "string | null",
  "direction": "bullish | bearish | null",
  "confidence": "65-74 | 75-84 | 85-92 | 93-97 | null",
  "conclusion": "confirmed | rejected | no_trade_today",
  "reason": "string"
}
```

## Project structure

```text
src/
  app/
    runScan.ts
  mcp/
    server.ts
    startServer.ts
  openai/
    client.ts
    runPromptWithScanner.ts
    testResponse.ts
  scanner/
    scoring.ts
  tradestation/
    client.ts
  index.ts
```

## Start locally

```bash
npm install
npm run mcp:start
```

Default URL:

- `http://localhost:3001/mcp`

Optional port override:

```bash
MCP_PORT=4000 npm run mcp:start
```

## Test locally

In another terminal, call JSON-RPC methods against `POST /mcp`.

### 1) Initialize

```bash
curl -s http://localhost:3001/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

### 2) List tools

```bash
curl -s http://localhost:3001/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### 3) Call tool

```bash
curl -s http://localhost:3001/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"scan_prompt_to_best_ticker","arguments":{"prompt":"find bullish setups","excludedTickers":["AAPL"]}}}'
```

## Build

```bash
npm run build
```
