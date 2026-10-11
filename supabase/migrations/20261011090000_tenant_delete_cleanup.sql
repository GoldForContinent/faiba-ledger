-- ===================================================================
-- Faiba Ledger — migration 10: deleting a tenant leaves nothing behind
-- -------------------------------------------------------------------
-- Deleting a tenants row already CASCADEs to that tenant's segments and
-- payments. The one table that was NOT covered is messages: since
-- migration 4 the chat thread lives under messages.thread_id (= md5 of
-- the tenant id) and there is deliberately no foreign key back to
-- tenants, so a hosted chat thread would survive its tenant forever.
--
-- This adds a BEFORE DELETE trigger on tenants that removes the
-- tenant's own thread. A tenant delete is now truly complete at the
-- database level; the app additionally clears its on-device caches.
-- ===================================================================

create or replace function public.delete_tenant_messages()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.messages where thread_id = public.thread_id_for(OLD.id);
  return OLD;
end;
$$;

drop trigger if exists tenants_delete_messages on public.tenants;
create trigger tenants_delete_messages
  before delete on public.tenants
  for each row execute function public.delete_tenant_messages();
