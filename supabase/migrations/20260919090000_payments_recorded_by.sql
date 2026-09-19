-- ===================================================================
-- Faiba Ledger — migration 7: who recorded each payment
-- -------------------------------------------------------------------
-- Adds `recorded_by` to payments so the manager (and the audit trail)
-- can show which operator typed a payment in. The value is the
-- operator's display name at the time of recording; it is denormalised
-- on purpose so history stays truthful even if an operator renames or
-- is removed. Old rows stay NULL (recorded before this column existed).
-- Existing ledger policies already let operators manage payments, so
-- no RLS change is required.
-- ===================================================================

alter table public.payments
  add column recorded_by text;