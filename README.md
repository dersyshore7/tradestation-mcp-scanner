# tradestation-mcp-scanner

A TypeScript MCP scanner/trader starter that uses TradeStation market data, a curated liquid-options universe, and separate paper/live automation lanes.

## What the MCP server does now

This project runs a **minimal HTTP MCP server** with two scan modes:

- Single-symbol TradeStation read-only analysis for prompts like `analyze AAPL`.
- Expanded static-universe TradeStation read-only scan-and-review for general prompts.

It exposes two tools:

- `scan_prompt_to_best_ticker`
- `construct_trade_card`

That tool checks for a single symbol prompt first. If present, it runs the same single-symbol read-only analysis.

If no single symbol is detected, it runs a real-data scan-and-review pipeline on a maintained static universe of roughly 500 liquid, options-heavy U.S. names and ETFs defined in `src/config/scanUniverseTiers.ts`.

If the real-data universe scan fails, the scanner fails closed with `no_trade_today`; it does not synthesize a mock candidate.



### Expanded static-universe scan-and-review mode

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

This is intentionally an expanded static universe for calibration and opportunity count; it is **not** a dynamic full-market symbol discovery engine.

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

Trade construction is read-only and returns a first-pass 2:1 trade card; the automation lane applies its configured per-entry account cap before placement.

### Tool input

```json
{
  "prompt": "string",
  "excludedTickers": ["string"]
}
```

`excludedTickers` is optional.

`excludedTickers` is optional and defaults to an empty list when omitted. The default general scan runs the configured static scan universe. Exclusions are mainly useful for reruns after a ticker was already reviewed/rejected.

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
- Use **Late Trade Review** for trades you took before recommendation history existed. It captures the real entry, optional current prices, stop/target levels, and thesis, reads fresh multi-timeframe chart context from TradeStation, then asks the read-only AI manager for hold/update-levels/consider-exit decision support.
- The page now also shows journal insights, recent journal trades, and lets you close a trade with realized P/L and review notes.

This UI is intentionally thin and does not place orders.

## Separate paper-trader module

The existing scanner workflow remains unchanged and read-only.

A separate automation module supports explicit TradeStation SIM paper trading and LIVE account automation lanes:

- API: `GET /api/paper-trader?mode=paper|live` for status, `POST /api/paper-trader` to run one automation cycle
- Dashboard API: `GET /api/paper-dashboard?mode=paper|live`
- Activity API: `GET /api/paper-activity?mode=paper|live`
- Cron/manual-run route: `GET /api/paper-trader-run?mode=paper|live`
- Full automation cron route: `GET /api/paper-trader-run?mode=paper|live&reconcileOrders=true` reconciles fills, manages open trades for that lane, and can enter new trades when guards allow
- Read-only monitor mode: `GET /api/paper-trader-run?mode=paper|live&reconcileOnly=true&reconcileOrders=true&skipNewEntry=true` is still available for manual order checks
- CLI: `npm run paper-trader:run -- --mode=paper|live`

What one automation cycle does:

1. Reconcile broker orders and positions with the isolated account-mode journal.
2. Run LIVE entries through the shared `support_resistance_v1` scan profile at ≥75% confidence and clean chart-anchored ≥2:1 structure.
3. Place the existing buy-to-open limit at bid plus one tick, capped at the decision midpoint; reprice once after 90 seconds and cancel any unfilled remainder after five minutes.
4. Manage new `support_resistance_v1` positions only from their recorded chart stop, chart target, fixed time exit, or 25% executable-bid premium loss.
5. Keep legacy LIVE positions on their recorded AI-management behavior until closed.
6. Apply the fixed portfolio and live-health gates and audit the decision quote, strategy version, risk snapshot, and broker state.

Adaptive reward and policy models remain available only as legacy diagnostics. They do not rank candidates, move levels, reprice orders, scale positions, or choose exits.

Automation exits store structured journal-exit truth fields for dashboard/accounting use: manual exits remain `manual`, broker fill prices record the TradeStation fill source, and quote fallbacks are marked `provisional_quote` instead of being inferred from note text.

LIVE behavior:

- Non-dry LIVE cron and manual cycles are order-enabled automatically; there are no activation, shadow, promotion, prompt, sizing, or order-placement environment gates.
- LIVE prompt overrides are rejected. The LIVE lane always uses `support_resistance_v1`.
- LIVE uses the same 30% account allocation, confirmed setup threshold, chart levels, and deterministic exits as the existing `support_resistance_ai` paper bot.
- The automation module only accepts official TradeStation SIM (`https://sim-api.tradestation.com/v3`) or LIVE (`https://api.tradestation.com/v3`) base URLs
- Broker affordability, duplicate position/order, quote-quality, and account-state checks still prevent invalid or duplicate orders without changing strategy selection.
- Live runs skip themselves outside regular US equity market hours; dry runs still work anytime
- Vercel Pro cron runs the full paper-trader cycle every 5 minutes on weekdays during the configured UTC window

Recommended env vars for the separate automation module:

```bash
PAPER_TRADESTATION_AUTOMATION_BASE_URL=https://sim-api.tradestation.com/v3
PAPER_TRADESTATION_AUTOMATION_ACCOUNT_ID=your_sim_account_id
PAPER_AUTO_TRADER_ALLOW_ORDER_PLACEMENT=0
PAPER_AUTO_TRADER_MANAGE_ENTRY_ORDERS=1
PAPER_AUTO_TRADER_MAX_POSITION_PCT=0.10
PAPER_AUTO_TRADER_SCAN_PROMPT=Run a new Scan for this week

LIVE_TRADESTATION_AUTOMATION_BASE_URL=https://api.tradestation.com/v3
LIVE_TRADESTATION_AUTOMATION_ACCOUNT_ID=your_live_account_id

```

The legacy TradeStation account/base-URL variables are LIVE-lane fallbacks only. Credentials, tokens, and the TradeStation account ID remain environment variables for security; behavioral LIVE gates are ignored.

The dashboard and automation routes do not require a separate operator API secret. Apply `supabase/migrations/20260730162857_live_trader_recovery.sql` before deploying code that reads strategy-version fields.

### Virtual paper automation dashboards

The website also exposes four paper-only virtual automations that share read-only TradeStation market data but keep separate `$10,000` journal ledgers:

- `politician_replica`
- `news_reasoning_ai`
- `leaps_investor_ai`
- `support_resistance_ai`

Use `automation=<key>` with the existing paper endpoints, for example:

```bash
curl "https://your-deployment.vercel.app/api/paper-dashboard?mode=paper&automation=politician_replica"
curl "https://your-deployment.vercel.app/api/paper-trader-run?mode=paper&automation=news_reasoning_ai"
```

These virtual bots never place TradeStation orders. They write journal-only entries and exits scoped by `paper_automation_key`, while the live lane remains unchanged. Congressional-disclosure and news-backed bots use Financial Modeling Prep when `FMP_API_KEY` is configured; without it they record a no-trade/source-warning cycle.

Dry-run example:

```bash
npm run paper-trader:run -- --mode=paper --dry-run
```

API trigger example:

```bash
curl -X POST https://your-deployment.vercel.app/api/paper-trader \
  -H "Content-Type: application/json" \
  -d '{"mode":"paper","dryRun":true}'
```

Cron/manual GET example:

```bash
curl "https://your-deployment.vercel.app/api/paper-trader-run?mode=paper&dryRun=true"
```

Read-only order monitor example:

```bash
curl "https://your-deployment.vercel.app/api/paper-trader-run?mode=paper&reconcileOnly=true&reconcileOrders=true&skipNewEntry=true"
```

Full automation run example:

```bash
curl "https://your-deployment.vercel.app/api/paper-trader-run?mode=paper&reconcileOrders=true"
```

Notes:

- This module is intentionally separate from `/api/workflow` and the current scanner UI.
- It is built for long single-leg options entries only.
- It uses the existing trade-card geometry for entry planning and frozen deterministic rules for executable management.
- `vercel.json` schedules both lanes. The live lane continues reconciliation and protective exits when entries are disabled.
- Use read-only monitor mode only for manual diagnostics; it reconciles partial fills and saved average entry price, but does not scan for new entries or send exit orders.
- Legacy adaptive analytics are visible for postmortems only and never influence executable decisions.
- The dashboard shows authority, block reasons, portfolio risk, broker-confirmed versus unresolved outcomes, and separate CALL/PUT validation gates.
- Apply `supabase/migrations/202604290001_paper_trader_runs.sql` to enable persisted cron/manual run history on the website.
- Apply `supabase/migrations/202604300001_paper_entry_candidates.sql` to enable persisted entry candidate audit history on the website.
- Apply `supabase/migrations/20260730162857_live_trader_recovery.sql` for frozen strategy versions, prospective shadow trades, daily risk snapshots, audits, and legacy backfill.

Policy-training debug:

```bash
npm run policy:train
```

## Supabase trade journal

The journal uses durable server-side persistence in Supabase Postgres.

- `POST /api/journal` validates and stores an initial journal trade entry. Mutating journal routes require bearer auth.
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
