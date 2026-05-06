-- Compact paper journal snapshots so learning/status reads do not pull full scan
-- and trade-card payloads on every automation cycle.
--
-- Keeps the fields the paper trader still needs:
-- - presentationSummary for human-readable entry rationale
-- - automation.paperTrader for order/position management, decision logs, and management history
-- - entryFeatures copied from the durable entry-candidate audit when available
-- - small selectedScan/tradeCardSummary objects for audit context

create index if not exists idx_paper_entry_candidates_trade_created_at
  on public.paper_entry_candidates(paper_trade_id, created_at desc);

update public.journal_trades t
set signal_snapshot_json = jsonb_strip_nulls(jsonb_build_object(
  'paperTraderCompact', true,
  'compactedAt', now(),
  'selectedScan', jsonb_build_object(
    'ticker', t.signal_snapshot_json #> '{scan,ticker}',
    'direction', t.signal_snapshot_json #> '{scan,direction}',
    'confidence', t.signal_snapshot_json #> '{scan,confidence}',
    'conclusion', t.signal_snapshot_json #> '{scan,conclusion}',
    'reason', t.signal_snapshot_json #> '{scan,reason}'
  ),
  'presentationSummary', t.signal_snapshot_json -> 'presentationSummary',
  'entryFeatures', coalesce(
    (
      select c.feature_json
      from public.paper_entry_candidates c
      where c.paper_trade_id = t.id
      order by c.created_at desc
      limit 1
    ),
    t.signal_snapshot_json -> 'entryFeatures',
    t.signal_snapshot_json #> '{automation,paperTrader,entryFeatures}'
  ),
  'tradeCardSummary', jsonb_build_object(
    'ticker', t.signal_snapshot_json #> '{tradeCard,ticker}',
    'direction', t.signal_snapshot_json #> '{tradeCard,direction}',
    'buy', t.signal_snapshot_json #> '{tradeCard,buy}',
    'rationale', t.signal_snapshot_json #> '{tradeCard,rationale}',
    'rrMath', t.signal_snapshot_json #> '{tradeCard,rrMath}',
    'expectedTiming', t.signal_snapshot_json #> '{tradeCard,expectedTiming}',
    'invalidationExit', t.signal_snapshot_json #> '{tradeCard,invalidationExit}',
    'takeProfitExit', t.signal_snapshot_json #> '{tradeCard,takeProfitExit}',
    'timeExit', t.signal_snapshot_json #> '{tradeCard,timeExit}'
  ),
  'automation', case
    when t.signal_snapshot_json ? 'automation'
      then jsonb_set(
        t.signal_snapshot_json -> 'automation',
        '{paperTrader,entryFeatures}',
        coalesce(
          (
            select c.feature_json
            from public.paper_entry_candidates c
            where c.paper_trade_id = t.id
            order by c.created_at desc
            limit 1
          ),
          t.signal_snapshot_json -> 'entryFeatures',
          t.signal_snapshot_json #> '{automation,paperTrader,entryFeatures}',
          '{}'::jsonb
        ),
        true
      )
    else null
  end
))
where t.account_mode = 'paper'
  and t.signal_snapshot_json is not null
  and (
    t.signal_snapshot_json ? 'scan'
    or t.signal_snapshot_json ? 'tradeCard'
    or pg_column_size(t.signal_snapshot_json) > 50000
  );

analyze public.journal_trades;
analyze public.paper_entry_candidates;
