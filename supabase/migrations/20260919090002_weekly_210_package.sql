-- ===================================================================
-- Faiba Ledger — migration 9: weekly-210 package
-- -------------------------------------------------------------------
-- Adds a Sh 210/week tier. The segments.package check constraint must
-- accept the new key so the manager's "Change package" and the Add
-- tenant / Bring-back forms can save it. Any already-billed cycles
-- keep the price they were recorded at, so widening the list is safe.
-- ===================================================================

alter table public.segments
  drop constraint if exists segments_package_check;

alter table public.segments
  add constraint segments_package_check check (
    package in ('daily','weekly','weekly-180','weekly-210','weekly','monthly-500','monthly-700','monthly-1000','monthly')
  );