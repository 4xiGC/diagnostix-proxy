-- 003_rvp_outcomes.sql
--
-- A DURABLE RECORD OF WHAT WAS DECIDED, so verification never again depends on
-- a log buffer that resets on every deploy.
--
-- On 2026-09-20 a swap defect had to be reconstructed by inference because the
-- only account of it had been wiped by the next deployment. Every field here
-- is one that was needed that day and was not available.
--
-- INSERT ONLY, deliberately. The one operation this service is known to be
-- able to perform on this database. Nothing here is ever updated.
--
-- NEVER AN ADDRESS. Domain and local part length only, which is what made two
-- different gmail addresses distinguishable in the logs from v8.11.29.

create table if not exists public.rvp_outcomes (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  kind            text not null,     -- 'webhook' | 'recover'
  secret_status   text,              -- 'valid' | 'invalid' | 'absent' | 'not-configured'
  decision        text,              -- 'exact' | 'inferred' | 'none' | 'swap' | 'recovery' | 'refused'
  reason          text,

  addr_domain     text,
  addr_local_len  int,
  survey_addr_domain text,
  survey_addr_local_len int,

  pending_row_id  uuid,
  delivered_restaurant text,
  delivered        boolean,
  claim_rows       int,              -- rows the atomic claim actually changed
  swap_used        boolean,
  stranded_count   int,
  stale_exact      boolean
);

create index if not exists rvp_outcomes_created_at_idx
  on public.rvp_outcomes (created_at desc);

comment on table public.rvp_outcomes is
  'Append-only decision record for every webhook and recovery POST. Written before the response. Insert only.';

alter table public.rvp_outcomes enable row level security;
