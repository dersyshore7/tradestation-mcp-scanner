# tradestation-mcp-scanner

A very small local MCP scanner starter in TypeScript.

## What this MCP skeleton does now

- Exposes one local MCP-style tool: `scan_prompt_to_best_ticker`.
- Accepts input:
  - `prompt: string`
  - `excludedTickers?: string[]`
- Returns a fake structured result:
  - `ticker`
  - `direction`
  - `confidence`
  - `conclusion`
  - `reason`
- Uses only mock logic (no OpenAI and no TradeStation integration yet).

### Fake behavior rules

- If `prompt` includes `bullish`, returns a fake bullish result.
- If `prompt` includes `bearish`, returns a fake bearish result.
- Otherwise returns `no_trade_today`.
- Respects `excludedTickers` so a hardcoded ticker like `AAPL` is skipped if excluded.

## Project structure

```text
src/
  app/
    runScan.ts
  mcp/
    server.ts
  openai/
    client.ts
    testResponse.ts
  scanner/
    scoring.ts
  tradestation/
    client.ts
  index.ts
```

## Run locally

```bash
npm install
npm run dev
```

## Local OpenAI test setup

1. Copy `.env.example` to `.env`.
2. Add your API key to `.env`.

```bash
cp .env.example .env
# then edit .env and set OPENAI_API_KEY=...
```

Run the local Responses API test:

```bash
npm run openai:test
```

## Scanner + OpenAI local tool flow

`scanner:test` runs a simple local OpenAI Responses API demo that:

- sends one hardcoded test prompt,
- exposes one function tool named `scan_prompt_to_best_ticker`,
- routes that tool call to the existing local fake scanner logic,
- sends the tool result back to Responses,
- prints the model's final text answer.

Run it locally:

```bash
cp .env.example .env
# set OPENAI_API_KEY in .env (or export it in your shell)
npm run scanner:test
```

## Test the fake scan tool locally

Quick bullish demo:

```bash
npx tsx -e "import { LocalMcpServer } from './src/mcp/server.ts'; const server = new LocalMcpServer(); console.log(server.callTool('scan_prompt_to_best_ticker', { prompt: 'show me bullish setups', excludedTickers: ['AAPL'] }));"
```

Quick bearish demo:

```bash
npx tsx -e "import { LocalMcpServer } from './src/mcp/server.ts'; const server = new LocalMcpServer(); console.log(server.callTool('scan_prompt_to_best_ticker', { prompt: 'looking bearish today' }));"
```

## Build and run compiled output

```bash
npm run build
npm run start
```
