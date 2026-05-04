-- Speed up the paper-trader dashboard's compact paper-only reads.

create index if not exists idx_journal_trades_account_mode_entry_date
  on public.journal_trades(account_mode, entry_date desc, created_at desc);

create index if not exists idx_journal_exits_trade_id_exit_time
  on public.journal_exits(trade_id, exit_time desc);
