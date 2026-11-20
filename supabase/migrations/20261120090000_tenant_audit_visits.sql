-- ===================================================================
-- Faiba Ledger — migration: tenant visit audit
-- -------------------------------------------------------------------
-- 1. Add 'tenant_view' to the audit_log kind check constraint
-- 2. Add a security-definer RPC so the tenant page can log its own
--    balance views (tenants have no auth session, they use phone+pin)
-- -------------------------------------------------------------------

alter table public.audit_log
  drop constraint if exists audit_log_kind_check;

alter table public.audit_log
  add constraint audit_log_kind_check check (
    kind in ('add','edit','remove','payment','away','back','access','other','tenant_view')
  );

-- Tenants call this after viewing their balance. Security-definer so it
-- can write to audit_log despite RLS; it only ever inserts kind='tenant_view'
-- for the tenant id passed in.
create or replace function public.log_tenant_view(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log (tenant_id, tenant_name, actor, unit, kind, summary, detail)
  select t.id, t.name, 'tenant', t.unit, 'tenant_view',
         format('Viewed balance on %s', to_char(now(), 'YYYY-MM-DD HH24:MI')),
         'Tenant opened their balance page'
    from public.tenants t
   where t.id = p_tenant_id;
end;
$$;

grant execute on function public.log_tenant_view(uuid) to anon, authenticated;
