-- ===================================================================
-- Faiba Ledger — migration 5: audit log + cash payments + new packages
-- -------------------------------------------------------------------
-- 1. Adds an `audit_log` table so the manager can show who did what
--    and when (a full trail of changes to the ledger).
-- 2. Adds a `method` column to payments ('mpesa' | 'cash') so cash
--    payments can be recorded without an M-Pesa transaction code.
-- 3. Adds the 700/week and 1000/week packages to the allowed package
--    values on segments.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. audit_log
-- -------------------------------------------------------------------
create table public.audit_log (
  id          uuid primary key,
  tenant_id   uuid references public.tenants(id) on delete set null,
  tenant_name text,
  actor       text,
  unit        text,
  kind        text not null default 'other'
              check (kind in ('add','edit','remove','payment','away','back','access','other')),
  summary     text not null default '',
  detail      text,
  created_at  timestamptz not null default now()
);

create index audit_log_created_idx on public.audit_log(created_at);
create index audit_log_tenant_idx on public.audit_log(tenant_id);

alter table public.audit_log enable row level security;

-- Owner + admins manage and read the audit log (they all run the ledger).
create policy "operators manage audit log" on public.audit_log for all
  using (exists (select 1 from public.operators o where o.id = auth.uid()))
  with check (exists (select 1 from public.operators o where o.id = auth.uid()));

-- -------------------------------------------------------------------
-- 2. payments.method ('mpesa' | 'cash')
-- -------------------------------------------------------------------
alter table public.payments
  add column method text not null default 'mpesa'
  check (method in ('mpesa','cash'));

-- -------------------------------------------------------------------
-- 3. New weekly packages on segments
-- -------------------------------------------------------------------
alter table public.segments
  drop constraint if exists segments_package_check;

alter table public.segments
  add constraint segments_package_check check (
    package in ('daily','weekly','weekly-180','weekly','weekly-700','weekly-1000','monthly-500','monthly')
  );
