-- Durable history for scanner trade-card recommendations.
-- Recommendations are not trades until the user explicitly journals one.

create table if not exists public.trade_recommendations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  scan_run_id text not null unique,
  prompt text null,
  symbol text not null,
  direction text not null check (direction in ('CALL','PUT')),
  confidence_bucket text null,
  planned_trade_json jsonb not null,
  signal_snapshot_json jsonb not null,
  journal_trade_id uuid null references public.journal_trades(id) on delete set null
);

create trigger set_trade_recommendations_updated_at
before update on public.trade_recommendations
for each row execute function public.set_updated_at();

create index if not exists idx_trade_recommendations_created_at on public.trade_recommendations(created_at desc);
create index if not exists idx_trade_recommendations_symbol on public.trade_recommendations(symbol);
create index if not exists idx_trade_recommendations_journal_trade_id on public.trade_recommendations(journal_trade_id);

alter table public.trade_recommendations disable row level security;
