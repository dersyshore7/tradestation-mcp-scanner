-- Shared short-lived TradeStation access-token cache for Vercel functions.
-- The refresh token remains only in environment variables.

create table if not exists public.tradestation_token_cache (
  cache_key text primary key,
  access_token text null,
  expires_at timestamptz null,
  refresh_locked_until timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.try_lock_tradestation_token_cache(
  p_cache_key text,
  p_lock_ms integer default 30000
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  did_lock boolean := false;
begin
  insert into public.tradestation_token_cache (
    cache_key,
    refresh_locked_until,
    updated_at
  )
  values (
    p_cache_key,
    now() + greatest(p_lock_ms, 0) * interval '1 millisecond',
    now()
  )
  on conflict (cache_key) do update
    set refresh_locked_until = excluded.refresh_locked_until,
        updated_at = now()
    where public.tradestation_token_cache.refresh_locked_until is null
       or public.tradestation_token_cache.refresh_locked_until <= now()
  returning true into did_lock;

  return coalesce(did_lock, false);
end;
$$;

alter table public.tradestation_token_cache disable row level security;
