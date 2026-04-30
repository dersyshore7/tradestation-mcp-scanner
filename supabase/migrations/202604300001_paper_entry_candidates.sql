-- Durable entry-candidate audit log for paper trader learning.
-- Access model for now: server-side API routes use service role key.

create table if not exists public.paper_entry_candidates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  scan_run_id text null,
  source text not null default 'paper_trader',
  dry_run boolean not null default false,
  symbol text null,
  decision text not null,
  decision_reason text null,
  paper_trade_id uuid null references public.journal_trades(id) on delete set null,
  order_id text null,
  direction text null,
  setup_type text null,
  confidence_bucket text null,
  dte_at_entry integer null,
  planned_reward_risk numeric(12,4) null,
  chart_review_score numeric(12,4) null,
  volume_ratio numeric(12,4) null,
  option_spread numeric(12,4) null,
  market_regime text null,
  scan_tier text null,
  entry_day text null,
  entry_time_bucket text null,
  entry_policy_decision text null,
  entry_policy_sample_size integer null,
  entry_policy_average_reward_r numeric(12,4) null,
  entry_policy_win_rate numeric(12,4) null,
  entry_policy_matched_key text null,
  entry_policy_summary text null,
  feature_json jsonb not null default '{}'::jsonb,
  scan_json jsonb null,
  trade_card_json jsonb null
);

create index if not exists idx_paper_entry_candidates_created_at on public.paper_entry_candidates(created_at desc);
create index if not exists idx_paper_entry_candidates_decision on public.paper_entry_candidates(decision);
create index if not exists idx_paper_entry_candidates_symbol on public.paper_entry_candidates(symbol);
create index if not exists idx_paper_entry_candidates_policy_decision on public.paper_entry_candidates(entry_policy_decision);

alter table public.paper_entry_candidates disable row level security;
