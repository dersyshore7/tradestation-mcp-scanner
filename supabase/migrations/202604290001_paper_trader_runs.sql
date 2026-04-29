-- Durable paper-trader run history.
-- Stores every successful cron/manual cycle outcome so automation visibility lives in the app.

create table if not exists public.paper_trader_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  mode text not null default 'paper',
  dry_run boolean not null default false,
  outcome text not null,
  symbol text null,
  reason text null,
  raw_result_json jsonb not null
);

create index if not exists idx_paper_trader_runs_created_at on public.paper_trader_runs(created_at desc);
create index if not exists idx_paper_trader_runs_outcome on public.paper_trader_runs(outcome);
create index if not exists idx_paper_trader_runs_symbol on public.paper_trader_runs(symbol);

alter table public.paper_trader_runs disable row level security;
