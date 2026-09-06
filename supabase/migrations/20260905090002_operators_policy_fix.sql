-- ===================================================================
-- Faiba Ledger — migration 3: operators RLS recursion fix
-- -------------------------------------------------------------------
-- Migration 2's operators policies referenced the operators table
-- inside their own expressions ("infinite recursion detected"). The
-- standard fix: read `operators` through security-definer helper
-- functions (they run as the definer, so no RLS re-entry), and use
-- those in the policies.
-- ===================================================================

create or replace function public.current_operator_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.operators where id = auth.uid();
$$;

create or replace function public.operator_count() returns int
language sql stable security definer set search_path = public as $$
  select count(*) from public.operators;
$$;

drop policy if exists "first operator self-registers as owner" on public.operators;
drop policy if exists "owner manages operators" on public.operators;
drop policy if exists "operators read operators" on public.operators;

-- First operator self-registers as owner, but only while the table is
-- empty. After that, the owner adds everyone else.
create policy "first operator self-registers as owner" on public.operators for insert
with check (auth.uid() = id and public.operator_count() = 0);

-- Owner manages the team (add admins, change roles, remove).
create policy "owner manages operators" on public.operators for all
using (public.current_operator_role() = 'owner')
with check (public.current_operator_role() = 'owner');

-- Any operator may read the team list (settings shows who has access).
create policy "operators read operators" on public.operators for select
using (public.current_operator_role() is not null);

-- The ledger-wide policies from migration 2 (tenants/segments/payments/
-- messages -> exists select from operators) are CROSS-table references,
-- which do not recurse; they are already live and untouched.