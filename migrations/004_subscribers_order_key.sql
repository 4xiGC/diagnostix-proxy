-- =============================================================================
-- DiagnostiX RVP: 004_subscribers_order_key
-- 4xi Global Consulting
--
-- Binds a subscriber row to the ORDER it was minted for.
--
-- REVIEWED AGAINST THE LIVE TABLE on 2026-09-22. public.subscribers has 34
-- columns and NOT ONE of them can hold an order reference:
--
--   id, email, first_name, restaurant_name, location, website, subscribed_at,
--   report_2_due, report_3_due, subscription_expires, baseline_report,
--   report_2, report_3, survey_data, report_1_score, report_2_score,
--   report_3_score, report_2_date, report_3_date, renewal_reminder_sent,
--   active, notes, next_report_at, reports_sent, baseline_score, latest_score,
--   plan_type, amount_paid, report_token, guest_count_change,
--   avg_check_change, profitability_change, renewal_reminder_at,
--   renewal_reminder_sent_at
--
-- Only id and email are NOT NULL without a default. There is no
-- payment_reference on this table; that column belongs to SVP.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
-- deliverPaidReport calls createCustomer on EVERY path, and createCustomer
-- INSERTS. The webhook does it once for the sale; the swap and recovery paths
-- do it again for the SAME sale, because they run the same flow. Measured on
-- 2026-09-22: one checkout plus one redelivery produced two subscriber rows.
--
-- So one sale can hold several rows, and the only way to pick one is the
-- newest row for an address. THAT IS THE LOOKUP THAT CAUSED THE 2026-09-20
-- DOUBLE DELIVERY. With this column the swap and recovery paths can find the
-- row the sale minted and UPDATE it, and "one sale, one row" becomes
-- enforceable rather than aspirational.
--
-- ── THE VALUE ───────────────────────────────────────────────────────────────
--
-- The SAME FORM rvp_swap_uses.order_key already stores, so the two tables can
-- be joined without a translation step. That column is plain text and its
-- stored values look like 'a8d661187041367d525c12faa63c'. Reusing the shape
-- rather than inventing a second one is the whole reason this column is named
-- order_key and not order_id.
--
-- ── NOT UNIQUE, AND THAT IS DELIBERATE ──────────────────────────────────────
--
-- The obvious next thought is a UNIQUE index. It would be wrong. A swap
-- legitimately replaces the report on an existing row, and a second row for
-- one order is exactly what this column exists to let the code AVOID creating,
-- not something the database should refuse on its behalf. A unique index here
-- would turn a logic bug into a 409 on a paid delivery.
--
-- ── NO BACKFILL ─────────────────────────────────────────────────────────────
--
-- All 100 existing rows get NULL, and NULL means "this row predates the column
-- and its order is not recoverable from this database". That is true: the
-- order identity for those rows exists only in the Wix export. Inventing one
-- would be worse than a null.
--
-- ── SAFETY ──────────────────────────────────────────────────────────────────
--
-- Additive and nullable, so every existing writer keeps working unchanged
-- whether or not it knows the column exists. The code that follows tolerates
-- its absence in the safe direction: if this migration has not been run, the
-- insert is retried without the field and the row still lands.
--
-- Run against: the RVP Supabase project, gxinqurxmstvoovfbgqr.
-- =============================================================================

alter table public.subscribers
  add column if not exists order_key text;

-- Partial, on non-null only, so it stays small while 100 of 100 existing rows
-- are null. This index supports the lookup the swap and recovery paths will
-- do: "find the row this order minted".
create index if not exists subscribers_order_key_idx
  on public.subscribers (order_key)
  where order_key is not null;

comment on column public.subscribers.order_key is
  'The order this row was minted for, in the same form rvp_swap_uses.order_key '
  'stores it, so the two join without translation. NULL means the row predates '
  'the column and its order is not recoverable from this database. IT IS NOT '
  'UNIQUE ON PURPOSE: a swap legitimately replaces the report on an existing '
  'row, and a unique index here would refuse the very operation this column '
  'exists to enable.';


-- =============================================================================
-- VERIFICATION, to run after the migration. All three are SELECT only.
-- =============================================================================

-- 1. The column exists, is text, and is NULLABLE. If is_nullable is NO,
--    something added a NOT NULL and every existing row would have had to be
--    backfilled, which this migration does not do.
--
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'subscribers'
--    and column_name = 'order_key';
--
--    EXPECT: order_key | text | YES | (null)

-- 2. NOTHING WAS BACKFILLED. Every existing row must still be null, and the
--    total must be unchanged at 100.
--
-- select count(*) as total,
--        count(order_key) as with_order_key,
--        count(*) - count(order_key) as null_order_key
--   from public.subscribers;
--
--    EXPECT: total 100, with_order_key 0, null_order_key 100

-- 3. The index exists and is PARTIAL. A full index here would be 100 null
--    entries doing nothing.
--
-- select indexname, indexdef
--   from pg_indexes
--  where schemaname = 'public'
--    and tablename = 'subscribers'
--    and indexname = 'subscribers_order_key_idx';
--
--    EXPECT: one row, and indexdef ending in WHERE (order_key IS NOT NULL)


-- =============================================================================
-- ROLLBACK
--
-- Safe to run at any point BEFORE the code that writes order_key is deployed.
-- After that code is live it would drop real data, so read the count in
-- verification query 2 first: if with_order_key is greater than 0, this
-- rollback DESTROYS those values and they are not recoverable from this
-- database.
-- =============================================================================

-- drop index if exists public.subscribers_order_key_idx;
-- alter table public.subscribers drop column if exists order_key;
