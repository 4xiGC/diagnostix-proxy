-- ════════════════════════════════════════════════════════════════════════════
-- DiagnostiX RVP, migration 001: pending_reports
--
-- RUN THIS BY HAND in the Supabase SQL editor for the diagnostix-restaurants
-- project. It can be run BEFORE or AFTER deploying v8.11.11: /save-report's
-- write to this table is best effort and logs its own failure, so the service
-- behaves exactly as it does today while the table is absent.
--
-- WHY. A finished survey lives only in an in-memory Map. Every deploy and every
-- restart destroys the report of anyone sitting between the survey and the
-- payment, and that report cannot be regenerated without re-running the
-- assessment. This table is the copy that survives.
--
-- SIZE. Measured over the 88 reports in subscribers.baseline_report:
--   min 5,994  median 13,047  mean 12,397  p90 16,713  max 21,469 bytes.
-- At 13 KB median and 30 day retention, a thousand surveys a month is ~13 MB.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.pending_reports (
  id                uuid primary key default gen_random_uuid(),
  email_normalized  text        not null,
  product           text        not null default 'full',
  report            jsonb,
  survey            jsonb,
  saved_at          timestamptz not null default now(),
  claimed_at        timestamptz,
  claimed_by        text,
  recovery_attempts integer     not null default 0,
  recovery_locked   boolean     not null default false
);

-- The matcher's two lookups. Both are restricted to unclaimed rows, so the
-- partial indexes stay small however long retention is.
create index if not exists pending_reports_email_unclaimed_idx
  on public.pending_reports (email_normalized, saved_at desc)
  where claimed_at is null;

create index if not exists pending_reports_window_unclaimed_idx
  on public.pending_reports (saved_at desc)
  where claimed_at is null;

-- Retention sweeps read this one.
create index if not exists pending_reports_saved_at_idx
  on public.pending_reports (saved_at);

comment on table  public.pending_reports is
  'Surveys finished but not yet paid for. Written by POST /save-report, read by the payment webhook and the recovery link. Rows are claimed once, never reused.';
comment on column public.pending_reports.claimed_by is
  'How the row was claimed: exact, inferred, or recovery. Null while unclaimed.';
comment on column public.pending_reports.recovery_attempts is
  'Failed email guesses against the recovery link for this row. Locks at 5.';

-- ── RETENTION ───────────────────────────────────────────────────────────────
-- Proposed: delete UNCLAIMED rows after 30 days, and CLAIMED rows after 90.
--
-- 30 days for unclaimed because a survey older than that will not be paid for,
-- and the row is a copy of a customer's business data that nothing will ever
-- use. 90 days for claimed because those are the rows that answer "which
-- survey did this order deliver", which is the question this whole change
-- exists to make answerable.
--
-- ENFORCEMENT. Not a cron and not application code that might not run: a
-- scheduled statement, so retention holds even if the service is down.
-- pg_cron must be enabled on the project first (Database, Extensions).
--
--   select cron.schedule(
--     'pending_reports_retention',
--     '17 3 * * *',
--     $$ delete from public.pending_reports
--         where (claimed_at is null and saved_at < now() - interval '30 days')
--            or (claimed_at is not null and saved_at < now() - interval '90 days') $$
--   );
--
-- If pg_cron is not available, run the delete by hand monthly. It is
-- idempotent and safe to run at any time.
