-- ===================================================================
-- Faiba Ledger — migration 2: operators & team access
-- -------------------------------------------------------------------
-- operators = the PEOPLE who run the business (owner + admins).
-- tenants   = the CUSTOMERS buying internet. Never mixed.
--
-- · First person to sign in self-registers as owner (bootstrap).
-- · Owner can add/remove admins; owner + admins all manage the ledger.
-- · Tenants table keeps owner_id (who created the row) but access is
--   now granted to any operator.
-- ===================================================================

create table public.operators (
  id           uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'admin' check (role in ('owner','admin')),
  name         text,
  created_at   timestamptz not null default now()
);

alter table public.operators enable row level security;

-- First operator self-registers as owner, but only while the table is
-- empty. After that, the owner adds everyone else.
create policy "first operator self-registers as owner" on public.operators for insert
with check (auth.uid() = id and not exists (select 1 from public.operators));

-- Owner manages the team (add admins, change roles, remove).
create policy "owner manages operators" on public.operators for all
using (exists (select 1 from public.operators o where o.id = auth.uid() and o.role = 'owner'))
with check (exists (select 1 from public.operators o where o.id = auth.uid() and o.role = 'owner'));

-- Any operator may read the team list (settings shows who has access).
create policy "operators read operators" on public.operators for select
using (exists (select 1 from public.operators o where o.id = auth.uid()));

-- -------------------------------------------------------------------
-- Widen ledger access from "the one owner" to "any operator".
-- owner_id on tenants stays (records who created it); the policies now
-- grant manage rights to owner + admins alike.
-- -------------------------------------------------------------------
drop policy if exists "owner manages own tenants" on public.tenants;
create policy "operators manage tenants" on public.tenants for all
using (exists (select 1 from public.operators o where o.id = auth.uid()))
with check (exists (select 1 from public.operators o where o.id = auth.uid()));

drop policy if exists "owner manages segments of own tenants" on public.segments;
create policy "operators manage segments" on public.segments for all
using (exists (select 1 from public.operators o where o.id = auth.uid()))
with check (exists (select 1 from public.operators o where o.id = auth.uid()));

drop policy if exists "owner manages payments of own tenants" on public.payments;
create policy "operators manage payments" on public.payments for all
using (exists (select 1 from public.operators o where o.id = auth.uid()))
with check (exists (select 1 from public.operators o where o.id = auth.uid()));

drop policy if exists "owner manages messages of own tenants" on public.messages;
create policy "operators manage messages" on public.messages for all
using (exists (select 1 from public.operators o where o.id = auth.uid()))
with check (exists (select 1 from public.operators o where o.id = auth.uid()));

-- -------------------------------------------------------------------
-- Existing Phase-2 tenant self-service policies stay untouched: a
-- linked tenant still reads only their own rows and writes only to
-- their own message thread.
-- -------------------------------------------------------------------