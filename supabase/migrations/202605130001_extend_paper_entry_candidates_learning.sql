-- Adds learning/audit fields for candidate-level reward attribution.

alter table public.paper_entry_candidates
add column if not exists ml_action text null,
add column if not exists ml_score_adjustment numeric(12,4) null,
add column if not exists selected boolean not null default false,
add column if not exists eventual_outcome_trade_id uuid null references public.journal_trades(id) on delete set null;

create index if not exists idx_paper_entry_candidates_selected on public.paper_entry_candidates(selected);
create index if not exists idx_paper_entry_candidates_ml_action on public.paper_entry_candidates(ml_action);
create index if not exists idx_paper_entry_candidates_eventual_outcome on public.paper_entry_candidates(eventual_outcome_trade_id);
