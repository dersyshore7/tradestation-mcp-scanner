-- Phase 1 trade journal schema.
-- Access model for now: server-side API routes use service role key.
-- TODO(phase2): Enable auth-backed RLS policies once user model is in place.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.journal_trades (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  scan_run_id text null,
  account_mode text not null check (account_mode in ('paper','live')),
  entry_date date not null,
  entry_time time null,
  symbol text not null,
  direction text not null check (direction in ('CALL','PUT')),
  expiration_date date null,
  dte_at_entry integer null,
  contracts integer null,
  position_cost_usd numeric(12,2) not null,
  underlying_entry_price numeric(12,4) null,
  option_entry_price numeric(12,4) null,
  planned_risk_usd numeric(12,2) null,
  planned_profit_usd numeric(12,2) null,
  setup_type text not null,
  setup_subtype text null,
  confidence_bucket text null,
  intended_stop_underlying numeric(12,4) null,
  intended_target_underlying numeric(12,4) null,
  market_regime text null,
  signal_snapshot_json jsonb null,
  entry_notes text null,
  status text not null default 'open' check (status in ('open','closed')),
  constraint journal_trades_expiration_not_before_entry
    check (expiration_date is null or expiration_date >= entry_date)
);

create table if not exists public.journal_exits (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null references public.journal_trades(id) on delete cascade,
  exit_time timestamptz not null,
  option_exit_price numeric(12,4) not null,
  quantity_closed integer not null,
  exit_reason text not null check (exit_reason in ('target_hit','stop_hit','time_exit','manual_early_exit','rule_violation','partial_profit','other')),
  fees_usd numeric(12,2) not null default 0,
  slippage_usd numeric(12,2) not null default 0,
  exit_notes text null
);

create table if not exists public.journal_reviews (
  trade_id uuid primary key references public.journal_trades(id) on delete cascade,
  followed_plan boolean null,
  winner boolean null,
  realized_pl_usd numeric(12,2) null,
  realized_r_multiple numeric(12,2) null,
  realized_return_pct numeric(12,2) null,
  rule_break_tags text[] not null default '{}',
  review_grade text null check (review_grade in ('A','B','C','D','F')),
  mistake_category text null,
  lessons_learned text null,
  review_notes text null
);

create trigger set_journal_trades_updated_at
before update on public.journal_trades
for each row execute function public.set_updated_at();

create index if not exists idx_journal_trades_entry_date on public.journal_trades(entry_date desc);
create index if not exists idx_journal_trades_symbol on public.journal_trades(symbol);
create index if not exists idx_journal_trades_setup_type on public.journal_trades(setup_type);
create index if not exists idx_journal_trades_status on public.journal_trades(status);

create index if not exists idx_journal_exits_trade_id on public.journal_exits(trade_id);
create index if not exists idx_journal_reviews_trade_id on public.journal_reviews(trade_id);

alter table public.journal_trades disable row level security;
alter table public.journal_exits disable row level security;
alter table public.journal_reviews disable row level security;
