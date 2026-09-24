-- ============================================================================
-- DiagnostiX RVP: 005_rvp_intake_review_data
-- 4xi Global Consulting
--
-- NOT APPLIED. Written overnight 2026-09-26 (Item 3) for Simon's approval.
--
-- ADD ONLY AND NULLABLE. NULL means the row predates this migration, or that
-- the value was not read (no Places match; no review date, which is every run
-- today because RVP makes no Place Details call).
--
-- The code already sends these columns and TOLERATES THEIR ABSENCE
-- (server.js insertTolerant): an insert rejected for one of them is retried
-- once without them. So this can be applied at any time after the code
-- deploys, and the code can deploy before it.
--
-- benchmarks is the Analytics project's table; its migrations are numbered in
-- diagnostix-analytics/migrations (the next is 012). It is here because this
-- service is the writer; copy part 1 there as 012 when approved.
-- ============================================================================

-- ── 1. benchmarks: the subject's own Google review data, at intake ─────────
alter table public.benchmarks
  add column if not exists subject_review_count int,
  add column if not exists subject_newest_review_at timestamptz;

comment on column public.benchmarks.subject_review_count is
  'RVP only: the subject''s own Google Places user_ratings_total at intake. '
  'NEVER a search knowledge-graph count. NULL: no Places match, or the row '
  'predates 2026-09-26.';
comment on column public.benchmarks.subject_newest_review_at is
  'RVP only: the newest Google review date read at intake. NULL on every row '
  'until RVP reads review dates (it makes no Place Details call today).';

-- ── 2. rvp_outcomes: what the review gate and the confirmation measured ────
alter table public.rvp_outcomes
  add column if not exists coverage_verdict text,
  add column if not exists place_id text,
  add column if not exists place_confirmed boolean,
  add column if not exists subject_review_count int,
  add column if not exists subject_newest_review_at timestamptz;

comment on column public.rvp_outcomes.coverage_verdict is
  'pass | limited | refused-coverage | declined-by-user | no-place-match. NULL '
  'means the row was not written by the review gate or the confirmation step.';
comment on column public.rvp_outcomes.place_id is
  'The Google Places id shown to the requester. With place_confirmed true, the '
  'id they confirmed.';

-- ── VERIFICATION (each with its expected answer) ────────────────────────────
-- 1. The seven columns exist, all nullable: expect 7 rows, is_nullable YES.
--    select table_name, column_name, data_type, is_nullable
--    from information_schema.columns
--    where table_schema = 'public'
--      and ((table_name = 'benchmarks' and column_name in ('subject_review_count','subject_newest_review_at'))
--        or (table_name = 'rvp_outcomes' and column_name in ('coverage_verdict','place_id','place_confirmed',
--                                                            'subject_review_count','subject_newest_review_at')))
--    order by 1, 2;
-- 2. No existing row changed: expect 0 and 0.
--    select count(*) from public.benchmarks where subject_review_count is not null or subject_newest_review_at is not null;
--    select count(*) from public.rvp_outcomes where coverage_verdict is not null or place_id is not null;
-- 3. Row counts unchanged (read immediately before applying; 2026-09-24: benchmarks 478, rvp_outcomes 26).
--    select (select count(*) from public.benchmarks), (select count(*) from public.rvp_outcomes);
-- 4. After the first survey run on the new code: its benchmark row has a count
--    equal to the "reviews=" figure in the [places] geocoded focal log line.
--    select subject_name, subject_review_count, created_at from public.benchmarks
--    where product = 'rvp' order by created_at desc limit 1;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Safe at any time: the code tolerates the columns' absence.
--    alter table public.benchmarks drop column if exists subject_review_count,
--                                  drop column if exists subject_newest_review_at;
--    alter table public.rvp_outcomes drop column if exists coverage_verdict,
--                                    drop column if exists place_id,
--                                    drop column if exists place_confirmed,
--                                    drop column if exists subject_review_count,
--                                    drop column if exists subject_newest_review_at;
