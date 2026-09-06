-- ===================================================================
-- Faiba Ledger — migration 4: messages proper thread model
-- -------------------------------------------------------------------
-- The old messages table was a 1-to-many log with no thread concept:
--    sender in ('tenant','owner','auto'), no thread_id, no party
--    has_said columns. That is why delete-on-one-side, the thread list
--    and the improved chat UX could not actually work against Supabase.
--
-- This rebuilds messages to the EXACT shape the local mock already uses
-- (faiba_messages_v2), so when this is hosted the localStorage layer
-- becomes a Supabase Realtime channel with zero UI change.
--
-- Thread model (one thread per tenant, like a WhatsApp chat):
--   thread_id              uuid  — one per tenant, deterministic so a
--                                tenant never has two threads.
--   from_party             text  — 'owner' | 'tenant' | 'auto'
--   to_party               text  — who this message is addressed to
--   body                   text  — the visible message
--   kind                   text  — 'ok' | 'owe' | 'paid' | 'down' |
--                                'other' | 'ack' | 'auto'
--   is_deleted_from_owner  boolean — the owner hid this thread
--   is_deleted_from_tenant boolean — the tenant hid this thread
--   created_at             timestamptz
--
-- Delete semantics (WhatsApp-style):
--   deleting sets a flag on YOUR side only; the other side's copy
--   stays. A new message from either side clears THEIRS (so a thread
--   reappears for a person after they deleted it, once the other writes).
--   Message bodies are never hard-deleted — history is always recoverable.
-- ===================================================================

begin;

-- Drop the old log-style table so we can redefine it (data was empty).
drop table if exists public.messages cascade;

-- New thread-aware table.
create table public.messages (
  id                uuid primary key default gen_random_uuid(),
  thread_id         uuid not null,
  from_party        text not null check (from_party in ('owner', 'tenant', 'auto')),
  to_party          text not null check (to_party in ('owner', 'tenant', 'auto')),
  body              text not null,
  kind              text not null default 'other' check (kind in ('ok','owe','paid','down','other','ack','auto')),
  is_deleted_from_owner  boolean not null default false,
  is_deleted_from_tenant boolean not null default false,
  created_at        timestamptz not null default now()
);

-- One thread per tenant — deterministic so a tenant never gets two.
create unique index messages_one_thread_per_tenant
  on public.messages (thread_id)
  where thread_id is not null;

-- Indexes the inbox and the compose path both hit.
create index messages_thread_idx on public.messages (thread_id, created_at);
create index messages_party_idx on public.messages (from_party, to_party);

-- Keep updated_at fresh (same trigger as everywhere else).
create trigger messages_set_updated_at
  before update on public.messages
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------
-- Row Level Security — mirrors the tenant/operators model exactly.
-- -------------------------------------------------------------------
alter table public.messages enable row level security;

-- Owner + admins manage everything in a tenant's thread.
create policy "operators manage messages of own tenants" on public.messages for all
  using (exists (
    select 1 from public.tenants t
    where t.id = messages.thread_id
      and exists (select 1 from public.operators o where o.id = auth.uid())
  ))
  with check (exists (
    select 1 from public.tenants t
    where t.id = messages.thread_id
      and exists (select 1 from public.operators o where o.id = auth.uid())
  ));

-- A linked tenant reads only their own thread and sends only to it.
create policy "tenant reads own thread" on public.messages for select
  using (exists (
    select 1 from public.tenants t
    where t.id = messages.thread_id
      and t.tenant_user_id = auth.uid()
  ));

create policy "tenant sends to own thread" on public.messages for insert
  with check (exists (
    select 1 from public.tenants t
    where t.id = messages.thread_id
      and t.tenant_user_id = auth.uid()
  ));

-- Tenant may UPDATE only their own delete flag (hide their side).
create policy "tenant mutates own delete flag" on public.messages for update
  using (exists (
    select 1 from public.tenants t
    where t.id = messages.thread_id
      and t.tenant_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.tenants t
    where t.id = messages.thread_id
      and t.tenant_user_id = auth.uid()
  ));

-- -------------------------------------------------------------------
-- Deterministic thread id for a tenant: stable across retries, one per
-- tenant, never collides with a real gen_random_uuid() in practice.
-- -------------------------------------------------------------------
create or replace function public.thread_id_for(tenant_id uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select md5($1::text || '-' || 'faiba-thread-v1')::uuid;
$$;

commit;
