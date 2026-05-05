-- Compact dashboard views for paper-trade analytics.
-- The app reads these small aggregate views instead of loading journal rows,
-- reviews, exits, and reasoning snapshots on every dashboard refresh.

create or replace view public.paper_dashboard_trade_facts as
select
  t.id as trade_id,
  t.created_at,
  t.entry_date,
  t.entry_time,
  case extract(isodow from t.entry_date)
    when 1 then 'Mon'
    when 2 then 'Tue'
    when 3 then 'Wed'
    when 4 then 'Thu'
    when 5 then 'Fri'
    when 6 then 'Sat'
    when 7 then 'Sun'
    else 'Unknown'
  end as entry_day_label,
  lower(case extract(isodow from t.entry_date)
    when 1 then 'Mon'
    when 2 then 'Tue'
    when 3 then 'Wed'
    when 4 then 'Thu'
    when 5 then 'Fri'
    when 6 then 'Sat'
    when 7 then 'Sun'
    else 'Unknown'
  end) as entry_day_key,
  case
    when t.entry_time is null then 'unknown'
    else substring(t.entry_time::text from 1 for 2) || ':00'
  end as entry_hour_key,
  case
    when t.entry_time is null then 'Unknown'
    when substring(t.entry_time::text from 1 for 2)::int = 0 then '12 AM'
    when substring(t.entry_time::text from 1 for 2)::int < 12 then substring(t.entry_time::text from 1 for 2)::int::text || ' AM'
    when substring(t.entry_time::text from 1 for 2)::int = 12 then '12 PM'
    else (substring(t.entry_time::text from 1 for 2)::int - 12)::text || ' PM'
  end as entry_hour_label,
  t.symbol,
  t.direction,
  t.setup_type,
  t.status,
  t.position_cost_usd,
  r.winner,
  r.realized_pl_usd,
  r.realized_r_multiple,
  r.realized_return_pct,
  coalesce(latest_exit.exit_reason, 'unknown') as latest_exit_reason
from public.journal_trades t
left join public.journal_reviews r on r.trade_id = t.id
left join lateral (
  select e.exit_reason
  from public.journal_exits e
  where e.trade_id = t.id
  order by e.exit_time desc
  limit 1
) latest_exit on true
where t.account_mode = 'paper';

create or replace view public.paper_dashboard_totals as
select
  count(*)::integer as total_trades,
  count(*) filter (where status = 'open')::integer as open_trades,
  count(*) filter (where realized_pl_usd is not null)::integer as closed_trades,
  coalesce(sum(position_cost_usd) filter (where status = 'open'), 0)::numeric as open_position_cost_usd,
  count(*) filter (where realized_pl_usd is not null and winner is true)::integer as winners,
  count(*) filter (where realized_pl_usd is not null and winner is false)::integer as losers,
  case
    when count(*) filter (where realized_pl_usd is not null) > 0
      then (count(*) filter (where realized_pl_usd is not null and winner is true))::numeric
        / (count(*) filter (where realized_pl_usd is not null))::numeric
    else null
  end as win_rate,
  coalesce(sum(realized_pl_usd) filter (where realized_pl_usd is not null), 0)::numeric as total_realized_pl_usd,
  avg(realized_r_multiple) filter (where realized_r_multiple is not null) as average_r_multiple,
  avg(realized_return_pct) filter (where realized_return_pct is not null) as average_return_pct
from public.paper_dashboard_trade_facts;

create or replace view public.paper_dashboard_buckets as
with expanded as (
  select 'day_of_week' as dimension, entry_day_key as key, entry_day_label as label, *
  from public.paper_dashboard_trade_facts

  union all

  select 'entry_hour' as dimension, entry_hour_key as key, entry_hour_label as label, *
  from public.paper_dashboard_trade_facts

  union all

  select 'direction' as dimension, direction as key, direction as label, *
  from public.paper_dashboard_trade_facts

  union all

  select 'setup_type' as dimension, setup_type as key, setup_type as label, *
  from public.paper_dashboard_trade_facts

  union all

  select 'symbol' as dimension, symbol as key, symbol as label, *
  from public.paper_dashboard_trade_facts

  union all

  select 'exit_reason' as dimension, latest_exit_reason as key, latest_exit_reason as label, *
  from public.paper_dashboard_trade_facts
  where realized_pl_usd is not null
)
select
  dimension,
  key,
  label,
  count(*)::integer as trade_count,
  count(*) filter (where status = 'open')::integer as open_trade_count,
  count(*) filter (where realized_pl_usd is not null)::integer as closed_trade_count,
  coalesce(sum(position_cost_usd) filter (where status = 'open'), 0)::numeric as open_position_cost_usd,
  count(*) filter (where realized_pl_usd is not null and winner is true)::integer as winner_count,
  count(*) filter (where realized_pl_usd is not null and winner is false)::integer as loser_count,
  case
    when count(*) filter (where realized_pl_usd is not null) > 0
      then (count(*) filter (where realized_pl_usd is not null and winner is true))::numeric
        / (count(*) filter (where realized_pl_usd is not null))::numeric
    else null
  end as win_rate,
  coalesce(sum(realized_pl_usd) filter (where realized_pl_usd is not null), 0)::numeric as realized_pl_usd,
  avg(realized_r_multiple) filter (where realized_r_multiple is not null) as average_r_multiple,
  avg(realized_return_pct) filter (where realized_return_pct is not null) as average_return_pct
from expanded
group by dimension, key, label;

analyze public.journal_trades;
analyze public.journal_reviews;
analyze public.journal_exits;
