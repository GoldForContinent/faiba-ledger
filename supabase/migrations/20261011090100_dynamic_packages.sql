-- ===================================================================
-- Faiba Ledger — migration 11: packages become data, not code
-- -------------------------------------------------------------------
-- Until now the package list was hardcoded in ledger-core.js AND frozen
-- in a CHECK constraint on segments. Adding a package meant a code
-- change plus a migration. This makes packages ordinary rows the
-- manager edits from Settings.
--
-- 1. public.packages — the catalogue (key, label, price, days, active).
-- 2. segments gains price + days: a SNAPSHOT of the package at the time
--    the tenure started. Balances are derived live, so if a price lived
--    only on the package, editing it would silently re-bill every past
--    cycle. The snapshot freezes what was actually sold; editing a
--    package only affects cycles that start afterwards.
-- 3. The old segments_package_check constraint is replaced with a real
--    foreign key to packages(key), so a package that is in use cannot
--    be deleted out from under its history.
-- 4. tenant_login() returns price + days so a tenant's own page shows
--    exactly what the manager shows.
-- ===================================================================

begin;

-- -------------------------------------------------------------------
-- 1. The package catalogue
-- -------------------------------------------------------------------
create table public.packages (
  key         text primary key,
  label       text not null,
  price       numeric not null check (price >= 0),
  days        integer not null check (days > 0),
  active      boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger packages_set_updated_at
  before update on public.packages
  for each row execute function public.set_updated_at();

alter table public.packages enable row level security;

-- Operators (owner + admins) run the shop: full control of the list.
create policy "operators manage packages" on public.packages for all
  using (exists (select 1 from public.operators o where o.id = auth.uid()))
  with check (exists (select 1 from public.operators o where o.id = auth.uid()));

-- Everyone (including the anon tenant page) may read the catalogue.
create policy "anyone reads packages" on public.packages for select
  using (true);

-- Seed the catalogue with exactly the packages that exist today.
insert into public.packages (key, label, price, days, sort_order) values
  ('daily',        'Daily',   30,   1,  1),
  ('weekly-180',   'Weekly',  180,  7,  2),
  ('weekly-210',   'Weekly',  210,  7,  3),
  ('weekly',       'Weekly',  200,  7,  4),
  ('monthly-500',  'Monthly', 500,  30, 5),
  ('monthly-700',  'Monthly', 700,  30, 6),
  ('monthly-1000', 'Monthly', 1000, 30, 7),
  ('monthly',      'Monthly', 800,  30, 8)
on conflict (key) do nothing;

-- -------------------------------------------------------------------
-- 2. Freeze the price on each segment
-- -------------------------------------------------------------------
alter table public.segments
  add column if not exists price numeric,
  add column if not exists days  integer;

-- Backfill existing history from today's catalogue so old cycles keep
-- the price they were sold at even before any package is edited.
update public.segments s
   set price = p.price,
       days  = p.days
  from public.packages p
 where s.package = p.key
   and (s.price is null or s.days is null);

-- -------------------------------------------------------------------
-- 3. Replace the frozen check with a foreign key
-- -------------------------------------------------------------------
alter table public.segments drop constraint if exists segments_package_check;

alter table public.segments drop constraint if exists segments_package_fk;
alter table public.segments
  add constraint segments_package_fk
  foreign key (package) references public.packages(key);

-- -------------------------------------------------------------------
-- 4. tenant_login(): include the frozen price + days
-- -------------------------------------------------------------------
create or replace function public.tenant_login(p_phone text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_phone text := public.norm_phone(p_phone);
  v_t     public.tenants%rowtype;
  v_segs  jsonb;
  v_pays  jsonb;
  v_expected text;
begin
  if v_phone = '' then
    return null;
  end if;

  select * into v_t
    from public.tenants
   where public.norm_phone(phone) = v_phone
   limit 1;

  if not found
     or v_t.access_salt is null
     or v_t.access_pin_hash is null then
    return null;
  end if;

  v_expected := encode(sha256(convert_to(v_t.access_salt || ':' || p_pin, 'UTF8')), 'hex');
  if v_expected <> v_t.access_pin_hash then
    return null;
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object('id', s.id, 'package', s.package,
                              'start', to_char(s.start_date, 'YYYY-MM-DD'),
                              'end', to_char(s.end_date, 'YYYY-MM-DD'),
                              'price', s.price, 'days', s.days)
           order by s.start_date), '[]'::jsonb)
    into v_segs
    from public.segments s
   where s.tenant_id = v_t.id;

  select coalesce(jsonb_agg(
           jsonb_build_object('id', p.id, 'date', to_char(p.date, 'YYYY-MM-DD'),
                              'amount', p.amount, 'method', p.method,
                              'ref', p.ref, 'note', p.note)
           order by p.date), '[]'::jsonb)
    into v_pays
    from public.payments p
   where p.tenant_id = v_t.id;

  return jsonb_build_object(
    'id', v_t.id,
    'name', v_t.name,
    'unit', v_t.unit,
    'phone', v_t.phone,
    'openedOn', to_char(v_t.opened_on, 'YYYY-MM-DD'),
    'openingArrears', v_t.opening_arrears,
    'segments', v_segs,
    'payments', v_pays
  );
end;
$$;

commit;
