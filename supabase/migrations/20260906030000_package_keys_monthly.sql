-- ===================================================================
-- Faiba Ledger — migration 6: correct 700/1000 package keys
-- -------------------------------------------------------------------
-- 700 and 1000 are MONTHLY tiers (30-day cycles), not weekly. The
-- previous migration named them weekly-700/weekly-1000 by mistake.
-- Since no tenants have used these keys yet, they are safely renamed
-- to monthly-700/monthly-1000.
-- ===================================================================

alter table public.segments
  drop constraint if exists segments_package_check;

alter table public.segments
  add constraint segments_package_check check (
    package in ('daily','weekly','weekly-180','weekly','monthly-500','monthly-700','monthly-1000','monthly')
  );
