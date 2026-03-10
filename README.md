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
