-- ===================================================================
-- Faiba Ledger — initial schema
-- Tenants are billing accounts made of stored FACTS (segments +
-- payments + opening balance); all money is derived client-side by
-- ledger-core.js, so no charges table is needed.
-- ===================================================================

-- ---------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------
create table public.tenants (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) default auth.uid(),
  name              text not null,
  unit              text not null,
  phone             text,
  opened_on         date not null,
  opening_arrears   numeric not null default 0,
  -- Phase 2 (tenant self-service): linked auth user + salted PIN hash
  tenant_user_id    uuid unique references auth.users(id),
  access_pin_hash   text,
  access_salt       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- segments — every stretch of time on the network (end = NULL while active)
-- ---------------------------------------------------------------
create table public.segments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  package      text not null check (package in ('daily','weekly','weekly-180','monthly','monthly-500')),
  start_date   date not null,
  end_date     date,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- payments — every shilling received (FIFO-credited oldest bill first)
-- ---------------------------------------------------------------
create table public.payments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  date         date not null default current_date,
  amount       numeric not null check (amount > 0),
  ref          text,           -- M-Pesa transaction code
  note         text,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- messages — the tenant-inbox thread (chat mock's storage, mapped)
-- ---------------------------------------------------------------
create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  sender           text not null check (sender in ('tenant','owner','auto')),
  kind             text not null default 'other' check (kind in ('down','owe','paid','other','ack','auto')),
  text             text not null,
  read             boolean not null default false,            -- owner has seen it
  read_by_tenant   boolean not null default false,            -- tenant has seen it
  ts               timestamptz not null default now(),
  mpesa_code       text
);

create index segments_tenant_idx   on public.segments(tenant_id);
create index payments_tenant_idx   on public.payments(tenant_id);
create index messages_tenant_idx   on public.messages(tenant_id);
create index messages_ts_idx       on public.messages(tenant_id, ts);

-- ---------------------------------------------------------------
-- keep updated_at fresh
-- ---------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger tenants_set_updated_at
before update on public.tenants
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- Row Level Security
-- Owner (auth.uid) manages everything; a linked tenant may READ their
-- own rows and SEND messages to their own thread — never write to the
-- ledger itself.
-- ---------------------------------------------------------------
alter table public.tenants   enable row level security;
alter table public.segments  enable row level security;
alter table public.payments  enable row level security;
alter table public.messages  enable row level security;

create policy "owner manages own tenants" on public.tenants for all
using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "owner manages segments of own tenants" on public.segments for all
using (exists (select 1 from public.tenants t where t.id = segments.tenant_id and t.owner_id = auth.uid()))
with check (exists (select 1 from public.tenants t where t.id = segments.tenant_id and t.owner_id = auth.uid()));

create policy "owner manages payments of own tenants" on public.payments for all
using (exists (select 1 from public.tenants t where t.id = payments.tenant_id and t.owner_id = auth.uid()))
with check (exists (select 1 from public.tenants t where t.id = payments.tenant_id and t.owner_id = auth.uid()));

create policy "owner manages messages of own tenants" on public.messages for all
using (exists (select 1 from public.tenants t where t.id = messages.tenant_id and t.owner_id = auth.uid()))
with check (exists (select 1 from public.tenants t where t.id = messages.tenant_id and t.owner_id = auth.uid()));

-- tenant self-service (Phase 2): read-only on their own ledger
create policy "tenant reads own account" on public.tenants for select
using (tenant_user_id = auth.uid());

create policy "tenant reads own segments" on public.segments for select
using (exists (select 1 from public.tenants t where t.id = segments.tenant_id and t.tenant_user_id = auth.uid()));

create policy "tenant reads own payments" on public.payments for select
using (exists (select 1 from public.tenants t where t.id = payments.tenant_id and t.tenant_user_id = auth.uid()));

-- tenant may read replies in their own thread and send messages to it
create policy "tenant reads own messages" on public.messages for select
using (exists (select 1 from public.tenants t where t.id = messages.tenant_id and t.tenant_user_id = auth.uid()));

create policy "tenant sends to own thread" on public.messages for insert
with check (exists (select 1 from public.tenants t where t.id = messages.tenant_id and t.tenant_user_id = auth.uid()));