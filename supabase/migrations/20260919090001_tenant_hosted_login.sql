-- ===================================================================
-- Faiba Ledger — migration 8: hosted tenant logins
-- -------------------------------------------------------------------
-- Fixes "That link no longer works" on clients' own phones. Before,
-- tenant.html only read this device's localStorage, so a client could
-- never match the phone + code the owner sent them. Now the tenant
-- page verifies against Supabase through the tenant_login() RPC below.
--
-- · tenants gains access_salt + access_pin_hash (the 4-digit code is
--   stored as sha256(salt || ':' || pin) — never plaintext at rest).
-- · Operators set/clear codes through owner_set_pin()/owner_clear_pin()
--   (security-definer, guarded by current_operator_role()).
-- · Anon tenants can only call tenant_login(), which returns the FULL
--   ledger ONLY when the phone + code match that tenant's row.
-- ===================================================================

alter table public.tenants
  add column if not exists access_pin_hash text,
  add column if not exists access_salt   text;

-- -------------------------------------------------------------------
-- Normalise Kenyan phone numbers exactly like ledger-core's
-- normalizePhone(): strip non-digits, drop a leading '+', map a
-- leading '0' or '1/7' to the 254 country code.
-- -------------------------------------------------------------------
create or replace function public.norm_phone(p text)
returns text
language plpgsql
immutable
as $$
declare
  x text := regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g');
begin
  if left(x, 1) = '+' then x := substring(x from 2); end if;
  if x = '' then return ''; end if;
  if left(x, 1) = '0' then
    x := '254' || substring(x from 2);
  elsif x ~ '^[17]' then
    x := '254' || x;
  end if;
  return x;
end;
$$;

-- -------------------------------------------------------------------
-- Operators: hash + store a code, or wipe a revoked code. The salt is
-- generated on the client (crypto.getRandomValues) and the pin is
-- hashed here, so the secret never touches the database in plaintext.
-- Security-definer so RLS can't reach in; guarded by the operator
-- check so only the team may set codes.
-- -------------------------------------------------------------------
create or replace function public.owner_set_pin(p_tenant_id uuid, p_salt text, p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_operator_role() is null then
    raise exception 'only operators may set access codes';
  end if;
  update public.tenants
     set access_salt   = p_salt,
         access_pin_hash = encode(sha256(convert_to(p_salt || ':' || p_pin, 'UTF8')), 'hex')
   where id = p_tenant_id;
end;
$$;

create or replace function public.owner_clear_pin(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_operator_role() is null then
    raise exception 'only operators may revoke access codes';
  end if;
  update public.tenants
     set access_salt = null, access_pin_hash = null
   where id = p_tenant_id;
end;
$$;

-- -------------------------------------------------------------------
-- The tenant page's one and only read path: phone + code in, the
-- tenant's own ledger out (jsonb, the exact nested shape the shared
-- ledger-core.js analyze()/renderAccount() expect). Returns SQL NULL
-- on any mismatch, so callers treat it as "this code is not valid".
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
                              'end', to_char(s.end_date, 'YYYY-MM-DD'))
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

-- Expose the right functions to the right roles.
revoke all on function public.tenant_login(text, text) from public;
grant execute on function public.tenant_login(text, text) to anon, authenticated;

revoke all on function public.owner_set_pin(uuid, text, text) from public;
grant execute on function public.owner_set_pin(uuid, text, text) to authenticated;

revoke all on function public.owner_clear_pin(uuid) from public;
grant execute on function public.owner_clear_pin(uuid) to authenticated;