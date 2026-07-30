-- Live trader recovery: immutable strategy versions, prospective shadow evidence,
-- daily risk baselines, and auditable deterministic order decisions.

alter table public.paper_entry_candidates
  add column if not exists account_mode text not null default 'paper'
    check (account_mode in ('paper', 'live')),
  add column if not exists ml_action text null,
  add column if not exists ml_score_adjustment numeric null,
  add column if not exists selected boolean not null default false,
  add column if not exists eventual_outcome_trade_id uuid null
    references public.journal_trades(id) on delete set null,
  add column if not exists strategy_version text not null default 'legacy_unversioned';

alter table public.paper_trader_runs
  add column if not exists strategy_version text not null default 'legacy_unversioned';

alter table public.journal_trades
  add column if not exists strategy_version text not null default 'legacy_unversioned',
  add column if not exists data_quality text not null default 'usable'
    check (data_quality in ('usable', 'provisional', 'unresolved', 'excluded'));

-- Preserve historical P/L, but do not invent outcomes for broker-filled rows that
-- have no authoritative exit record.
update public.journal_trades as trade
set
  data_quality = 'unresolved',
  entry_notes = concat_ws(
    E'\n',
    nullif(trade.entry_notes, ''),
    'Marked unresolved during recovery migration: entry fill metadata exists but no authoritative closing fill is recorded.'
  )
where trade.status = 'closed'
  and trade.data_quality = 'usable'
  and not exists (
    select 1
    from public.journal_exits as journal_exit
    where journal_exit.trade_id = trade.id
  )
  and (
    lower(coalesce(trade.signal_snapshot_json #>> '{automation,paperTrader,entryFillStatus}', '')) = 'filled'
    or case
      when coalesce(
        trade.signal_snapshot_json #>> '{automation,paperTrader,filledQuantity}',
        ''
      ) ~ '^[0-9]+(?:\.[0-9]+)?$'
      then (trade.signal_snapshot_json #>> '{automation,paperTrader,filledQuantity}')::numeric
      else 0
    end > 0
  );

create table if not exists public.strategy_versions (
  version text primary key,
  direction text not null check (direction in ('CALL', 'PUT', 'BOTH')),
  status text not null default 'shadow'
    check (status in ('shadow', 'promoted', 'halted', 'retired')),
  config_json jsonb not null,
  code_commit_sha text not null,
  shadow_account_value_usd numeric not null default 10000
    check (shadow_account_value_usd > 0),
  validation_started_at timestamptz not null default now(),
  promoted_at timestamptz null,
  retired_at timestamptz null,
  validation_summary_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.strategy_shadow_trades (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  strategy_version text not null references public.strategy_versions(version),
  candidate_id uuid null references public.paper_entry_candidates(id) on delete set null,
  scan_run_id text null,
  session_date date not null,
  symbol text not null,
  direction text not null check (direction in ('CALL', 'PUT')),
  option_symbol text not null,
  status text not null default 'open' check (status in ('open', 'closed', 'excluded')),
  quantity integer not null default 1 check (quantity > 0),
  entry_time timestamptz not null,
  entry_underlying_price numeric null,
  entry_bid numeric null,
  entry_ask numeric not null check (entry_ask > 0),
  entry_quote_json jsonb not null default '{}'::jsonb,
  intended_stop_underlying numeric not null,
  intended_target_underlying numeric not null,
  time_exit_date date not null,
  planned_risk_usd numeric not null check (planned_risk_usd > 0),
  exit_time timestamptz null,
  exit_reason text null,
  exit_underlying_price numeric null,
  exit_bid numeric null,
  exit_quote_json jsonb null,
  fees_usd numeric not null default 0,
  slippage_usd numeric not null default 0,
  realized_pl_usd numeric null,
  realized_r_multiple numeric null,
  mfe_usd numeric null,
  mae_usd numeric null,
  max_option_bid numeric null,
  min_option_bid numeric null,
  quote_observation_count integer not null default 1,
  data_quality text not null default 'usable'
    check (data_quality in ('usable', 'provisional', 'missing_quote', 'unresolved', 'excluded')),
  exclusion_reason text null
);

create table if not exists public.strategy_daily_risk_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  account_mode text not null check (account_mode in ('paper', 'live')),
  session_date date not null,
  account_value_usd numeric not null check (account_value_usd > 0),
  realized_pl_usd numeric not null default 0,
  open_unrealized_pl_usd numeric null,
  entry_count integer not null default 0 check (entry_count >= 0),
  equity_peak_usd numeric not null check (equity_peak_usd > 0),
  risk_snapshot_json jsonb not null default '{}'::jsonb,
  unique (account_mode, session_date)
);

create table if not exists public.strategy_order_audits (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  account_mode text not null check (account_mode in ('paper', 'live')),
  strategy_version text not null default 'legacy_unversioned',
  journal_trade_id uuid null references public.journal_trades(id) on delete set null,
  symbol text null,
  option_symbol text null,
  decision_kind text not null,
  action text not null,
  outcome text null,
  rule_id text not null,
  input_quote_json jsonb null,
  risk_snapshot_json jsonb null,
  broker_state_json jsonb null,
  note text not null
);

create or replace function public.protect_strategy_version_definition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version is distinct from old.version
    or new.direction is distinct from old.direction
    or new.config_json is distinct from old.config_json
    or new.code_commit_sha is distinct from old.code_commit_sha
    or new.shadow_account_value_usd is distinct from old.shadow_account_value_usd
    or new.validation_started_at is distinct from old.validation_started_at
  then
    raise exception 'Strategy version definitions are immutable; create a new version.';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_strategy_version_definition
  on public.strategy_versions;
create trigger protect_strategy_version_definition
before update on public.strategy_versions
for each row execute function public.protect_strategy_version_definition();

create index if not exists idx_paper_entry_candidates_selected
  on public.paper_entry_candidates(selected);
create index if not exists idx_paper_entry_candidates_ml_action
  on public.paper_entry_candidates(ml_action);
create index if not exists idx_paper_entry_candidates_eventual_outcome
  on public.paper_entry_candidates(eventual_outcome_trade_id);
create index if not exists idx_journal_trades_strategy_lane
  on public.journal_trades(account_mode, paper_automation_key, strategy_version, entry_date desc);
create index if not exists idx_paper_candidates_strategy_created
  on public.paper_entry_candidates(
    account_mode,
    paper_automation_key,
    strategy_version,
    direction,
    created_at desc
  );
create index if not exists idx_paper_runs_strategy_created
  on public.paper_trader_runs(mode, paper_automation_key, strategy_version, created_at desc);
create index if not exists idx_shadow_strategy_status
  on public.strategy_shadow_trades(strategy_version, status, entry_time desc);
create index if not exists idx_shadow_candidate
  on public.strategy_shadow_trades(candidate_id)
  where candidate_id is not null;
create unique index if not exists idx_shadow_deduplicate_session
  on public.strategy_shadow_trades(strategy_version, session_date, symbol)
  where status <> 'excluded';
create index if not exists idx_order_audits_strategy_created
  on public.strategy_order_audits(strategy_version, created_at desc);
create index if not exists idx_order_audits_journal_trade
  on public.strategy_order_audits(journal_trade_id)
  where journal_trade_id is not null;

insert into public.strategy_versions (
  version,
  direction,
  status,
  config_json,
  code_commit_sha,
  shadow_account_value_usd
)
values
  (
    'continuation_call_v1',
    'CALL',
    'shadow',
    '{"entry":"bid_plus_one_tick_capped_at_decision_mid","reprice_after_seconds":90,"max_reprices":1,"cancel_after_seconds":300,"premium_stop_pct":25,"dynamic_management":false}'::jsonb,
    'runtime',
    10000
  ),
  (
    'continuation_put_v1',
    'PUT',
    'shadow',
    '{"entry":"bid_plus_one_tick_capped_at_decision_mid","reprice_after_seconds":90,"max_reprices":1,"cancel_after_seconds":300,"premium_stop_pct":25,"dynamic_management":false}'::jsonb,
    'runtime',
    10000
  ),
  (
    'support_resistance_v1',
    'BOTH',
    'promoted',
    '{"scan_prompt":"Run a new Scan for this week using only clean support and resistance structure, chart-anchored invalidation, and clear 2:1 room.","minimum_confidence_pct":75,"minimum_reward_risk":2,"entry":"bid_plus_one_tick_capped_at_decision_mid","reprice_after_seconds":90,"max_reprices":1,"cancel_after_seconds":300,"max_position_premium_pct":5,"max_position_planned_risk_pct":1,"max_aggregate_premium_pct":10,"max_aggregate_planned_risk_pct":2,"max_open_positions":2,"max_open_positions_per_direction":1,"max_entries_per_day":2,"max_daily_loss_pct":1,"max_drawdown_pct":5,"rolling_health_trade_count":20,"minimum_rolling_profit_factor":1,"premium_stop_pct":25,"dynamic_management":false,"scale_outs":false,"weekend_forced_exits":false}'::jsonb,
    'runtime',
    10000
  )
on conflict (version) do nothing;

update public.journal_trades
set strategy_version = 'support_resistance_v1'
where account_mode = 'paper'
  and paper_automation_key = 'support_resistance_ai'
  and strategy_version = 'legacy_unversioned';

update public.paper_entry_candidates
set strategy_version = 'support_resistance_v1'
where account_mode = 'paper'
  and paper_automation_key = 'support_resistance_ai'
  and strategy_version = 'legacy_unversioned';

update public.paper_trader_runs
set strategy_version = 'support_resistance_v1'
where mode = 'paper'
  and paper_automation_key = 'support_resistance_ai'
  and strategy_version = 'legacy_unversioned';

alter table public.strategy_versions enable row level security;
alter table public.strategy_shadow_trades enable row level security;
alter table public.strategy_daily_risk_snapshots enable row level security;
alter table public.strategy_order_audits enable row level security;

drop policy if exists server_service_role_all on public.strategy_versions;
create policy server_service_role_all on public.strategy_versions
  for all to service_role using (true) with check (true);
drop policy if exists server_service_role_all on public.strategy_shadow_trades;
create policy server_service_role_all on public.strategy_shadow_trades
  for all to service_role using (true) with check (true);
drop policy if exists server_service_role_all on public.strategy_daily_risk_snapshots;
create policy server_service_role_all on public.strategy_daily_risk_snapshots
  for all to service_role using (true) with check (true);
drop policy if exists server_service_role_all on public.strategy_order_audits;
create policy server_service_role_all on public.strategy_order_audits
  for all to service_role using (true) with check (true);

revoke all privileges on table
  public.strategy_versions,
  public.strategy_shadow_trades,
  public.strategy_daily_risk_snapshots,
  public.strategy_order_audits
from anon, authenticated;

grant select, insert, update, delete on table
  public.strategy_versions,
  public.strategy_shadow_trades,
  public.strategy_daily_risk_snapshots,
  public.strategy_order_audits
to service_role;

notify pgrst, 'reload schema';
