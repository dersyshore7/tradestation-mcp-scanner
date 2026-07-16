-- Separate virtual paper automations that share the same paper TradeStation account.
-- Existing paper/live rows are preserved as the legacy paper-trader automation.

alter table public.journal_trades
  add column if not exists paper_automation_key text not null default 'legacy_paper_trader';

alter table public.paper_trader_runs
  add column if not exists paper_automation_key text not null default 'legacy_paper_trader';

alter table public.paper_entry_candidates
  add column if not exists paper_automation_key text not null default 'legacy_paper_trader';

create index if not exists idx_journal_trades_account_automation
  on public.journal_trades(account_mode, paper_automation_key, entry_date desc, created_at desc);

create index if not exists idx_paper_trader_runs_mode_automation_created
  on public.paper_trader_runs(mode, paper_automation_key, created_at desc);

create index if not exists idx_paper_entry_candidates_automation_created
  on public.paper_entry_candidates(paper_automation_key, created_at desc);
