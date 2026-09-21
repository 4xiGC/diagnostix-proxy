-- 002_rvp_swap_uses.sql
--
-- SINGLE USE THAT CANNOT FAIL OPEN.
--
-- On 2026-09-20 a swap link was used twice and delivered the same report
-- twice, 15:27:25 and 15:28:05 UTC. Single use depended on writing a SWAPPED
-- marker onto the order's subscribers row and reading it back on the next
-- click, and the read looked at the wrong row: delivering INSERTS a subscriber
-- row, which is then the newest for that address, so the second click read a
-- fresh row with null notes and answered "not yet swapped".
--
-- A guarantee the application has to write, find again and interpret is not a
-- guarantee. This replaces it with an INSERT against a UNIQUE key, so the
-- database refuses the second use rather than the application noticing it.
--
-- FAILS CLOSED. If this table is absent the swap is REFUSED, not allowed. The
-- code tolerates its absence in the safe direction only.

create table if not exists public.rvp_swap_uses (
  id            uuid primary key default gen_random_uuid(),
  -- The identity of the ORDER, not of the link. One order gets one swap, and
  -- a reissued link for the same order is still the same entitlement.
  order_key     text        not null,
  used_at       timestamptz not null default now(),
  -- Diagnostics only. Never an address: domain and local part length.
  addr_domain   text,
  addr_local_len int,
  survey_addr_domain text,
  survey_addr_local_len int,
  restaurant    text,
  pending_row_id uuid,
  report_token  text
);

-- THE GUARANTEE. The second insert for one order raises 23505 and the swap is
-- refused. Nothing in the application has to remember, check or update.
create unique index if not exists rvp_swap_uses_order_key_uniq
  on public.rvp_swap_uses (order_key);

create index if not exists rvp_swap_uses_used_at_idx
  on public.rvp_swap_uses (used_at desc);

comment on table public.rvp_swap_uses is
  'One row per swap actually used. The unique index on order_key is the single-use guarantee; it is enforced by the database, not by the application.';

alter table public.rvp_swap_uses enable row level security;
