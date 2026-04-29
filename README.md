# tradestation-mcp-scanner

A very small beginner-friendly MCP scanner starter in TypeScript.

## What the MCP server does now

This project runs a **minimal HTTP MCP server** with two scan modes:

- Single-symbol TradeStation read-only analysis for prompts like `analyze AAPL`.
- Small-universe TradeStation read-only scan-and-review for general prompts.

It exposes two tools:

- `scan_prompt_to_best_ticker`
- `construct_trade_card`

That tool checks for a single symbol prompt first. If present, it runs the same single-symbol read-only analysis.

If no single symbol is detected, it now runs a tiny real-data scan-and-review pipeline on a hardcoded V1 scan universe of about 100 liquid, options-heavy U.S. names defined in `src/app/runScan.ts` (`V1_SCAN_UNIVERSE_CONFIG`).

The fake scanner fallback is still present only as a safety fallback if real-data requests fail.



### Small-universe scan-and-review mode

General prompts (for example, `find bullish setups`) now run a simple 4-stage read-only pipeline:

1. **Stage 1: Basic stock filters**
   - Price between 10 and 500
   - Average volume above 1M when available
   - Respect `excludedTickers`
2. **Stage 2: Options tradability filters**
   - Check available expirations
   - Prefer 14–21 DTE when available
   - Require open interest above 500 on a candidate contract
   - Require reasonably tight bid/ask spread
3. **Stage 3: Basic chart/bar review**
   - Pull recent daily bars
   - Simple first-pass trend + volume support check
   - Classify candidate as bullish, bearish, or fail stage
4. **Stage 4: Final pick**
   - Score remaining candidates with a simple score
   - Return best candidate, otherwise `no_trade_today`

This is intentionally a tiny starter pipeline and does **not** scan the full market.

### Stage 3 starter-universe telemetry debug

Use the Stage 3 debug script when you want quick calibration telemetry without changing tool output:

```bash
npm run scanner:stage3-debug
```

The script now prints, in this order:

1. Stage pass counts (`stage1Entered`, `stage1Passed`, `stage2Passed`, `stage3Passed`, `finalRanking`)
2. Concise rejection summaries for Stages 1/2/3
3. Top 3 Stage 3 near misses (`symbol`, `direction`, `score`, `hardFailReasons`, `softIssueReasons`, `infoReasons`)
4. Concise per-symbol Stage 3 review summary (defaults to first 20 rows; set `STAGE3_DEBUG_MAX_LINES` to adjust)

This telemetry is debug-only. The MCP tool response shape stays unchanged:

- `ticker`
- `direction`
- `confidence`
- `conclusion`
- `reason`

### Single-symbol prompt examples

- `analyze AAPL`
- `review AAPL`
- `scan AAPL`

### Trade construction prompt examples

- `build trade OXY`
- `trade setup OXY`
- `construct trade OXY`

Trade construction is read-only and returns a first-pass 2:1 trade card with 33% account-equity sizing (or env fallback if account balances are unavailable).

### Tool input

```json
{
  "prompt": "string",
  "excludedTickers": ["string"]
}
```

`excludedTickers` is optional.

`excludedTickers` is optional and defaults to an empty list when omitted. The default V1 general scan runs the full V1 universe. Exclusions are mainly useful for reruns after a ticker was already reviewed/rejected.

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

It uses the shared default scan prompt and now sends no exclusions unless you explicitly provide them:

- `prompt`: `Run a new Scan for this week`
- `excludedTickers`: optional (not sent by default in this demo flow)

This endpoint must stay live and publicly reachable so OpenAI can connect to it during tool use.

Run locally:

```bash
npm install
OPENAI_API_KEY=your_key_here npm run scanner:test
```

## Thin Vercel UI (first pass)

A minimal UI is available at the project root (`/`) for running the existing scan -> confirm -> trade-card workflow.

- Click **Run Scan** to call `POST /api/workflow`.
- The API reuses existing engine functions (`runScan` and `constructTradeCard`) without changing scan/trade logic.
- If no confirmed setup exists, the UI shows `no_trade_today`.
- If confirmed, it shows the scan reasoning and full trade card plus an **I took this trade** modal that persists to Supabase via `POST /api/journal`.
- Confirmed trade-card recommendations are also saved to **Past Recommendations**, so you can revisit prior reasoning after a refresh or a newer scan and journal the older setup if you actually took it.
- Use **Late Trade Review** for trades you took before recommendation history existed. It captures the real entry, optional current prices, stop/target levels, and thesis, then asks the read-only AI manager for hold/update-levels/consider-exit decision support.
- The page now also shows journal insights, recent journal trades, and lets you close a trade with realized P/L and review notes.

This UI is intentionally thin and does not place orders.

## Separate paper-trader module

The existing scanner workflow remains unchanged and read-only.

A separate SIM-only automation lane now exists for paper trading:

- API: `GET /api/paper-trader` for status, `POST /api/paper-trader` to run one automation cycle
- Cron/manual-run route: `GET /api/paper-trader-run`
- CLI: `npm run paper-trader:run`

What one paper-trader cycle does:

1. Load open paper trades from the journal
2. Let the AI manager reassess any open paper trades using current quotes, the original thesis, recent management history, and rewarded feedback from similar closed paper trades
3. Feed the AI manager a first-pass trained policy prior that is learned from closed paper trades and their management outcomes
4. Tighten active stop/target levels or exit early when the AI manager decides the thesis has weakened or protecting gains is better than waiting
5. If guards allow, run a fresh scan
6. Build a trade card
7. Preview the TradeStation order
8. Optionally place the order in TradeStation SIM
9. Journal the new paper trade with execution metadata for later management

New paper trades now seed AI management state in `signal_snapshot_json`, including active stop/target levels plus a short management history so later 5-minute reviews can update the trade instead of re-reading the original entry only.

Safety defaults:

- Disabled until you set `AUTO_TRADER_ENABLED=1`
- Order placement stays off until you set `AUTO_TRADER_ALLOW_ORDER_PLACEMENT=1`
- The automation module refuses to run unless its base URL points to TradeStation SIM
- The API route can be protected with `AUTO_TRADER_API_SECRET` or `CRON_SECRET`
- Live runs skip themselves outside regular US equity market hours; dry runs still work anytime
- The runtime is ready for a 5-minute manager loop, but the repo does not enable it in `vercel.json` yet so Hobby deployments keep working until you upgrade Vercel

Recommended env vars for the separate automation module:

```bash
AUTO_TRADER_ENABLED=1
AUTO_TRADER_ALLOW_ORDER_PLACEMENT=0
AUTO_TRADER_MAX_OPEN_TRADES=1
AUTO_TRADER_MAX_DAILY_LOSS_USD=300
AUTO_TRADER_SCAN_PROMPT=Run a new Scan for this week
AUTO_TRADER_API_SECRET=your_long_random_secret

TRADESTATION_AUTOMATION_BASE_URL=https://sim-api.tradestation.com/v3
TRADESTATION_AUTOMATION_ACCOUNT_ID=your_sim_account_id
```

Dry-run example:

```bash
npm run paper-trader:run -- --dry-run
```

API trigger example:

```bash
curl -X POST https://your-deployment.vercel.app/api/paper-trader \
  -H "Authorization: Bearer your_long_random_secret" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true}'
```

Cron/manual GET example:

```bash
curl "https://your-deployment.vercel.app/api/paper-trader-run?dryRun=true" \
  -H "Authorization: Bearer your_long_random_secret"
```

Notes:

- This module is intentionally separate from `/api/workflow` and the current scanner UI.
- It is built for long single-leg options entries only.
- It uses the existing trade-card logic for entry planning and an AI manager for ongoing paper-trade assessment.
- Use `/api/paper-trader-run` for Vercel cron because Vercel cron invokes a `GET` request.
- The current AI manager now includes a first trained contextual policy layer learned from closed paper trades, plus rewarded experience memory in the prompt.

Policy-training debug:

```bash
npm run policy:train
```

## Supabase trade journal

The journal uses durable server-side persistence in Supabase Postgres.

- `POST /api/journal` validates and stores an initial journal trade entry.
- `GET /api/journal` returns recent entries.
- `GET /api/journal/:id` returns one entry.
- `PUT /api/journal/:id` edits saved journal fills, timestamps, and review notes while recalculating derived P/L.
- `PATCH /api/journal/:id` stores a trade closeout and review summary.
- `GET /api/journal/insights` returns journal analytics such as win rate, weekday profitability, setup performance, and recent winner/loser reasoning comparisons.
- `POST /api/late-trade-review` reviews and optionally journals a trade that was already taken manually before it existed in the app.
- `GET /api/recommendations` returns recent saved trade-card recommendations.
- `PATCH /api/recommendations/:id` marks a recommendation as journaled after it becomes an actual trade entry.
- Schema migrations live in `supabase/migrations`.

Saved journal entries now keep richer scanner context in `signal_snapshot_json`, including:

- scan result and scan reasoning
- workflow presentation summary
- trade-card rationale and expected timing
- a journal-friendly reasoning snapshot for later winner/loser comparisons

Required env vars:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... # optional for future browser auth/client usage
SUPABASE_SERVICE_ROLE_KEY=...            # server-only; never expose in browser code
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
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"scan_prompt_to_best_ticker","arguments":{"prompt":"Run a new Scan for this week"}}}'
```

## Build

```bash
npm run build
```
