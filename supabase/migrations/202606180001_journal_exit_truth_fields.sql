-- Structured exit-price provenance for broker-vs-journal truth.

alter table public.journal_exits
  add column if not exists exit_price_source text not null default 'manual',
  add column if not exists broker_confirmed boolean not null default false,
  add column if not exists broker_repaired boolean not null default false,
  add column if not exists broker_order_id text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'journal_exits_exit_price_source_check'
      and conrelid = 'public.journal_exits'::regclass
  ) then
    alter table public.journal_exits
      add constraint journal_exits_exit_price_source_check
      check (exit_price_source in (
        'manual',
        'provisional_quote',
        'order_response',
        'executions',
        'orders',
        'broker_legacy_note'
      ));
  end if;
end $$;

update public.journal_exits
set exit_price_source = 'provisional_quote'
where exit_notes ilike '%provisional%'
  and exit_price_source = 'manual';

update public.journal_exits
set
  exit_price_source = 'broker_legacy_note',
  broker_confirmed = true,
  broker_repaired = true
where exit_notes ilike '%broker-confirmed tradestation fill%';

analyze public.journal_exits;
