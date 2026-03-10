# tradestation-mcp-scanner

A very small beginner-friendly MCP scanner starter in TypeScript.

## What the MCP server does now

This project runs a **minimal HTTP MCP server** with two scan modes:

- Single-symbol TradeStation read-only analysis for prompts like `analyze AAPL`.
- Existing fake-data fallback when no single symbol is detected.

It exposes exactly one tool:

- `scan_prompt_to_best_ticker`

That tool now checks for a single symbol prompt first, then uses TradeStation **read-only** market data (`quotes`, plus recent bars when available) for a simple first-pass direction guess.

If no single symbol is detected, it keeps using the existing fake scanner logic in `src/app/runScan.ts`.


### Single-symbol prompt examples

- `analyze AAPL`
- `review AAPL`
- `scan AAPL`

The first-pass real-data mode only handles one symbol and does **not** scan the full market yet.

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
api/
  mcp.ts
src/
  app/
    runScan.ts
  mcp/
    rpc.ts
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
vercel.json
```

## TradeStation read-only auth setup (starter)

This phase adds only a **read-only** local auth helper for getting tokens.

It does **not** place orders, does **not** add market scanning, and does **not** wire TradeStation into MCP yet.

Set these environment variables in `.env`:

```bash
TRADESTATION_API_KEY=your_api_key
TRADESTATION_API_SECRET=your_api_secret
TRADESTATION_REDIRECT_URI=http://localhost:3001
TRADESTATION_BASE_URL=https://api.tradestation.com/v3
```

Then follow these steps:

1. Generate the login URL:

```bash
npm run tradestation:auth-url
```

2. Open the printed URL in your browser and log in.
3. After login, TradeStation redirects to your localhost URL.
4. Copy the `code` value from that redirect URL.
   - Example redirect: `http://localhost:3001/?code=YOUR_CODE_HERE`
5. Exchange the code for tokens:

```bash
npm run tradestation:exchange-code -- YOUR_CODE_HERE
```

6. Copy the printed refresh token and save it in `.env`:

```bash
TRADESTATION_REFRESH_TOKEN=your_refresh_token
```

Optional read-only smoke test after saving your refresh token:

```bash
npm run tradestation:test
```

## OpenAI remote MCP scanner test

`npm run scanner:test` now uses the OpenAI Responses API with the deployed remote MCP server:

- `https://tradestation-mcp-scanner.vercel.app/api/mcp`

This endpoint must stay live and publicly reachable so OpenAI can connect to it during tool use.

Run locally:

```bash
npm install
OPENAI_API_KEY=your_key_here npm run scanner:test
```

## Local MCP server (still works)

```bash
npm install
npm run mcp:start
```

Default local URL:

- `http://localhost:3001/mcp`

Optional port override:

```bash
MCP_PORT=4000 npm run mcp:start
```

## Vercel MCP endpoint

This repo now also includes a Vercel API route at:

- `api/mcp.ts`

After deployment, expect this MCP endpoint path:

- `https://<your-vercel-project>.vercel.app/api/mcp`

JSON-RPC methods are the same in both local and Vercel modes:

- `initialize`
- `tools/list`
- `tools/call`

## Test locally with curl

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
