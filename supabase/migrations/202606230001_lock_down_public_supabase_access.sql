-- Lock down public-schema data API exposure.
-- Access model: app/API code uses SUPABASE_SERVICE_ROLE_KEY server-side.

alter table public.journal_trades enable row level security;
alter table public.journal_exits enable row level security;
alter table public.journal_reviews enable row level security;
alter table public.paper_trader_runs enable row level security;
alter table public.paper_entry_candidates enable row level security;
alter table public.tradestation_token_cache enable row level security;

drop policy if exists server_service_role_all on public.journal_trades;
create policy server_service_role_all
on public.journal_trades
for all
to service_role
using (true)
with check (true);

drop policy if exists server_service_role_all on public.journal_exits;
create policy server_service_role_all
on public.journal_exits
for all
to service_role
using (true)
with check (true);

drop policy if exists server_service_role_all on public.journal_reviews;
create policy server_service_role_all
on public.journal_reviews
for all
to service_role
using (true)
with check (true);

drop policy if exists server_service_role_all on public.paper_trader_runs;
create policy server_service_role_all
on public.paper_trader_runs
for all
to service_role
using (true)
with check (true);

drop policy if exists server_service_role_all on public.paper_entry_candidates;
create policy server_service_role_all
on public.paper_entry_candidates
for all
to service_role
using (true)
with check (true);

drop policy if exists server_service_role_all on public.tradestation_token_cache;
create policy server_service_role_all
on public.tradestation_token_cache
for all
to service_role
using (true)
with check (true);

do $$
begin
  if to_regclass('public.trade_recommendations') is not null then
    alter table public.trade_recommendations enable row level security;

    drop policy if exists server_service_role_all on public.trade_recommendations;
    create policy server_service_role_all
    on public.trade_recommendations
    for all
    to service_role
    using (true)
    with check (true);
  end if;
end $$;

revoke all privileges on table
  public.journal_trades,
  public.journal_exits,
  public.journal_reviews,
  public.paper_trader_runs,
  public.paper_entry_candidates,
  public.tradestation_token_cache
from anon, authenticated;

grant select, insert, update, delete on table
  public.journal_trades,
  public.journal_exits,
  public.journal_reviews,
  public.paper_trader_runs,
  public.paper_entry_candidates,
  public.tradestation_token_cache
to service_role;

do $$
begin
  if to_regclass('public.trade_recommendations') is not null then
    revoke all privileges on table public.trade_recommendations from anon, authenticated;
    grant select, insert, update, delete on table public.trade_recommendations to service_role;
  end if;
end $$;

alter view public.paper_dashboard_trade_facts set (security_invoker = true);
alter view public.paper_dashboard_totals set (security_invoker = true);
alter view public.paper_dashboard_buckets set (security_invoker = true);

revoke all privileges on table
  public.paper_dashboard_trade_facts,
  public.paper_dashboard_totals,
  public.paper_dashboard_buckets
from anon, authenticated;

grant select on table
  public.paper_dashboard_trade_facts,
  public.paper_dashboard_totals,
  public.paper_dashboard_buckets
to service_role;

alter function public.set_updated_at() set search_path = public;

revoke all privileges on function public.set_updated_at() from public, anon, authenticated;
grant execute on function public.set_updated_at() to service_role;

revoke all privileges on function public.try_lock_tradestation_token_cache(text, integer) from public, anon, authenticated;
grant execute on function public.try_lock_tradestation_token_cache(text, integer) to service_role;

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated;

notify pgrst, 'reload schema';
