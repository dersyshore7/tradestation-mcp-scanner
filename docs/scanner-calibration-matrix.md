# Scanner prompt-to-logic calibration matrix

This is a developer-facing doctrine map for the current `runScan` implementation. It is intentionally calibration-oriented, not a redesign.

| Doctrine clause | Current logic classification | Current implementation notes | Calibration note |
| --- | --- | --- | --- |
| Broader U.S. options market | Preference only | Starter universe is still curated U.S. large-cap / ETF symbols, not a full market sweep. | Still approximate by design. |
| Price $10-$500 | Hard veto | Stage 1 price filter enforces range. | Kept strict. |
| Avg volume >1M | Hard veto | Stage 1 average-volume filter enforces threshold. | Kept strict as initial liquidity gate. |
| Tight option spreads | Hard veto | Stage 2 spread threshold rejects serious tradability failures. | Kept strict. |
| OI >500 | Hard veto | Stage 2 OI threshold rejects low-interest contracts. | Kept strict. |
| Clean candlestick + volume structures | Weighted soft penalty / confidence drag | Stage 3 reviews body/wick, expansion, volume, chop, pullback control, and trigger-zone behavior. | Relaxed mild cases so they drag score/confidence before they reject. |
| Prefer breakout/expansion + impulse/consolidation | Preference only + weighted soft penalty | Expansion and impulse/consolidation remain influential, but not automatic hard fails. | Mild misses are now more clearly treated as downgraders. |
| Fake-hold/distribution should downgrade confidence or block when truly problematic | Weighted soft penalty / confidence drag | Distribution remains a meaningful structural weakness in confirmation. | Kept meaningful, but not a blanket veto by itself. |
| Room to 2R should matter | Mixed: soft room check + hard veto for true 2R failure | `higher-timeframe-room` is softer; `higher-timeframe-2r-viability` remains blocking. | Kept doctrinally strict in confirmation/trade-card path. |
| Failed-breakout / bull-trap should matter | Hard veto | Failed breakout / trap remains a blocker. | Kept strict. |
| Messy candles / trigger-zone chop should matter | Weighted soft penalty / confidence drag | Body/wick, chop, and trigger-zone instability all feed confirmation weakness scoring. | Overlap is now de-stacked so related cautions do not over-punish. |
| Return exactly one ticker or no_trade_today | Hard workflow rule | Stable deterministic finalist flow already does this. | Unchanged. |
| Confidence bands 65-74 / 75-84 / 85-92 / 93-97 | Partially implemented | Scanner uses 65-74 / 75-84 / 85-92; 93-97 is still not produced. | Left approximate for now. |
| Prompt 2 stricter review with candle bodies/wicks/volume | Hard workflow rule with weighted penalties | Confirmation still re-checks body/wick, volume, continuation, structure, and 2R viability. | Preserved. |
| Multi-timeframe alignment | Hard veto | Alignment failure still rejects. | Preserved. |
| Confirmed requires >=75 confidence and true clean 2:1 support | Hard veto | Confirmation still rejects 65-74 and any false 2R support. | Preserved. |
| Earnings inside DTE window | Hard veto | Earnings check rejects symbols inside the target DTE window. | Preserved. |
| Serious tradability failures | Hard veto | Price/liquidity/options spread/OI failures still block upstream. | Preserved. |

## Likely prior over-strict interpretations

- Mild weak-volume readings near the threshold were being punished too heavily in confirmation.
- Body/wick, impulse/consolidation, and trigger-zone/chop issues could stack too aggressively when they described similar price-action messiness.
- Expansion weakness was already soft, but adjacent soft issues could still combine into rejection faster than the prompt doctrine suggests.
- Confirmation logic was stricter than the prompt wording in some `prefer` / `downgrade` / `avoid` situations; this patch keeps those as confidence drags unless the broader picture is genuinely weak.
