-- Shrink paper-trader audit payloads that can make small Supabase projects time out.
-- The scalar columns and feature columns remain; oversized raw scan/trade-card/run blobs
-- are compacted because the app renders decision history from the scalar fields.

update public.paper_trader_runs
set raw_result_json = jsonb_strip_nulls(jsonb_build_object(
  'compacted', true,
  'compacted_at', now(),
  'mode', raw_result_json -> 'mode',
  'timestamp', raw_result_json -> 'timestamp',
  'dryRun', raw_result_json -> 'dryRun',
  'dryRunReason', raw_result_json -> 'dryRunReason',
  'guards', raw_result_json -> 'guards',
  'reconciliation', jsonb_build_object(
    'inspected', raw_result_json #> '{reconciliation,inspected}',
    'updated', raw_result_json #> '{reconciliation,updated}',
    'updates', coalesce(raw_result_json #> '{reconciliation,updates}', '[]'::jsonb),
    'skipped', coalesce(raw_result_json #> '{reconciliation,skipped}', '[]'::jsonb)
  ),
  'management', jsonb_build_object(
    'inspected', raw_result_json #> '{management,inspected}',
    'updates', coalesce(raw_result_json #> '{management,updates}', '[]'::jsonb),
    'exitsTriggered', coalesce(raw_result_json #> '{management,exitsTriggered}', '[]'::jsonb),
    'skipped', coalesce(raw_result_json #> '{management,skipped}', '[]'::jsonb)
  ),
  'entry', jsonb_build_object(
    'attempted', raw_result_json #> '{entry,attempted}',
    'outcome', raw_result_json #> '{entry,outcome}',
    'symbol', raw_result_json #> '{entry,symbol}',
    'reason', raw_result_json #> '{entry,reason}',
    'orderId', raw_result_json #> '{entry,orderId}',
    'journalTradeId', raw_result_json #> '{entry,journalTradeId}'
  )
))
where raw_result_json is not null
  and (
    raw_result_json ? 'paperTradeHistory'
    or raw_result_json ? 'decisionLog'
    or raw_result_json ? 'runHistory'
    or pg_column_size(raw_result_json) > 50000
  );

update public.paper_entry_candidates
set
  scan_json = null,
  trade_card_json = null
where scan_json is not null
   or trade_card_json is not null;

create index if not exists idx_journal_trades_paper_status_entry_date
  on public.journal_trades(account_mode, status, entry_date desc, created_at desc);

create index if not exists idx_journal_reviews_winner
  on public.journal_reviews(winner);

analyze public.paper_trader_runs;
analyze public.paper_entry_candidates;
analyze public.journal_trades;
analyze public.journal_reviews;
analyze public.journal_exits;
