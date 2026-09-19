# Faiba Ledger — Supabase integration guide (v2 ledger)

## Status

- ✅ **Schema live.** Migration `supabase/migrations/20260905090000_init_schema.sql`
  was pushed to the `FaibaLedger` project (`zmzsahvhczzxqobiqjzj`): tables
  `tenants`, `segments`, `payments`, `messages`, RLS policies, `updated_at`
  trigger — all verified live.
- ✅ **Manager is cloud-backed.** `app.js` now talks to Supabase via
  `supabase-client.js` (publishable key), and `login.html` signs into the real
  Supabase owner account (email + password). No session → the manager
  redirects to `login.html`.
- ✅ **One-time data lift.** Settings → *Upload this device's tenants to the
  cloud* pushes any demo data still in this device's `localStorage` into
  Supabase (idempotent — skips ids already in the cloud, deletes nothing).
- ✅ **Operators & team (live).** `operators` table (`owner`/`admin`) with
  RLS: the first person to sign in self-registers as owner; the owner can add
  and remove admins from Settings → Team; any operator manages the full
  ledger. `login.html` has an Owner/Tenant toggle.
- ✅ **Hosted tenant logins (live).** `tenant.html` now verifies phone + code
  server-side via the `tenant_login()` RPC (migration `…0001`): codes are
  hashed (`sha256(salt || ':' || pin)`, columns `access_pin_hash` +
  `access_salt`), operators set/clear them through
  `owner_set_pin()`/`owner_clear_pin()`, and a tenant on their own phone gets
  back only their own ledger (no localStorage needed). The demo's same-device
  fallback still exists.
- ⏳ **Hosted chat — still local.** `tenant.html` and the manager's
  inbox/presence mock still read `localStorage` (`faiba_messages_v2` /
  `faiba_presence_v2`). Message threads only sync between pages opened on the
  same device/browser. See Phase 2 below for the hosted plan.

## Files

| File | Role |
|------|------|
| `index.html` + `app.js` | the reseller's manager (guarded by a real Supabase session) |
| `login.html` | Supabase owner sign-in (email + password) |
| `tenant.html` + `app-tenant.js` | a tenant's read-only self-service page (phone + access code, local demo) |
| `ledger-core.js` | the pure accounting engine **shared by both pages** — balances are always derived from stored facts, so the tenant page and the manager can never disagree |
| `supabase-client.js` | Supabase client + session helper used by the manager and login page |
| `supabase/migrations/` | versioned SQL (the live schema) |
| `style.css` | the design system shared by all pages |

**Everything the app does goes through one object: `DB` in `app.js`.**
The rendering, forms, and the whole accounting engine (`analyze`,
`buildCharges`, `simulateClose`, `migrateV1`) are pure — they read the
stored *facts* and derive the money. Only `DB` (and `supabase-client.js`)
touch the backend.

**Access codes stay on-device** (localStorage `faiba_access_pins_v1`, keyed by
tenant id) until Phase 2 replaces them with server-side hashed PINs.

---

## 1. The v2 data model

> ✅ This model is **already implemented** — the tables below are live. Keep
> reading to understand the shapes `DB` maps between.

A tenant is now a **billing account** made of three stored facts:

| Fact | What it stores |
|------|----------------|
| `tenants` | identity (name, unit, phone), `opened_on`, `opening_arrears` |
| `segments` | every stretch of time on the network: package, `start_date`, `end_date` (`NULL` = currently active) |
| `payments` | every shilling received: date, amount, M-Pesa `ref`, note |

Nothing else is stored. Balances, arrears, prepaid credit, per-cycle
breakdowns and "who owes what" are **derived at render time** by
`analyze()` in `app.js`, which implements:

1. **A cycle is billed the day it starts.** A tenure opened on day X bills
   its first cycle on X, the next at X + cycle-length, and so on. (Daily = 1
   day, Weekly = 7, Monthly = 30.)
2. **Marking someone away closes their open segment** on the chosen date and
   bills the half-finished cycle pro-rata for the days actually used.
3. **Coming back pushes a new open segment** — fresh clock and billing from
   the arrival date, on whatever package is chosen then.
4. **Payments are credits applied oldest-bill-first** (FIFO). Overpaying
   creates prepaid credit that eats future cycles automatically.
5. **`opening_arrears`** is billed once, dated `opened_on`, for debt a tenant
   carried from before the app started tracking them.

> ⚠️ This means you do **not** need a `charges` table. Charges are a pure
> function of segments + payments + today's date. If you ever want a
> server-side charges table (e.g. for analytics), derive it with the same
> rules rather than duplicating logic.

## 2. Schema

Run this in the Supabase SQL editor.

```sql
create table tenants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) default auth.uid(),
  name text not null,
  unit text not null,
  phone text,
  opened_on date not null,
  opening_arrears numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table segments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  package text not null check (package in ('daily','weekly','weekly-180','weekly','monthly','monthly-500','monthly-700','monthly-1000')),
  start_date date not null,
  end_date date              -- null while the tenant is active
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  date date not null default current_date,
  amount numeric not null,
  method text not null default 'mpesa' check (method in ('mpesa','cash')),
  ref text,                  -- M-Pesa transaction code (null for cash)
  note text
);

create index segments_tenant_idx on segments(tenant_id);
create index payments_tenant_idx on payments(tenant_id);

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger tenants_set_updated_at
before update on tenants
for each row execute function set_updated_at();
```

### Row Level Security (owner)

```sql
alter table tenants enable row level security;
alter table segments enable row level security;
alter table payments enable row level security;

create policy "owner manages tenants" on tenants for all
using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "owner manages segments" on segments for all
using (exists (select 1 from tenants t where t.id = segments.tenant_id and t.owner_id = auth.uid()))
with check (exists (select 1 from tenants t where t.id = segments.tenant_id and t.owner_id = auth.uid()));

create policy "owner manages payments" on payments for all
using (exists (select 1 from tenants t where t.id = payments.tenant_id and t.owner_id = auth.uid()))
with check (exists (select 1 from tenants t where t.id = payments.tenant_id and t.owner_id = auth.uid()));
```

## 3. Auth (Phase 1 — owner only)

> ✅ **Implemented.** `login.html` calls `supabase.auth.signInWithPassword`;
> `index.html` guards on the persisted session token and redirects to
> `login.html` when absent; the lock button signs out via
> `supabase.auth.signOut`. Create the owner account once in the Supabase
> dashboard (Authentication → Users → Add user) with the email/password you
> want to sign in with.

## 4. The `DB` object

> ✅ **Implemented in `app.js`** — the live `DB` keeps the same method names
> and the nested return shape the UI expects:

```
tenant = {
  id, name, unit, phone,
  openedOn: 'YYYY-MM-DD',
  openingArrears: 0,
  segments: [{ id, package, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD'|null }],
  payments: [{ id, date: 'YYYY-MM-DD', amount, ref, note }],
  createdAt, updatedAt
}
```

```js
const DB = {
  async getAll() {
    const { data: ts, error: tErr } = await supabase
      .from('tenants').select('*').order('created_at');
    if (tErr) throw tErr;
    const { data: segs, error: sErr } = await supabase
      .from('segments').select('*').order('start_date');
    if (sErr) throw sErr;
    const { data: pays, error: pErr } = await supabase
      .from('payments').select('*').order('date');
    if (pErr) throw pErr;

    return ts.map(row => ({
      id: row.id,
      name: row.name,
      unit: row.unit,
      phone: row.phone,
      openedOn: row.opened_on,
      openingArrears: row.opening_arrears,
      segments: segs
        .filter(s => s.tenant_id === row.id)
        .map(s => ({ id: s.id, package: s.package, start: s.start_date, end: s.end_date })),
      payments: pays
        .filter(p => p.tenant_id === row.id)
        .map(p => ({ id: p.id, date: p.date, amount: p.amount, ref: p.ref, note: p.note })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  },

  async insert(tenant) {
    const { data, error } = await supabase.from('tenants').insert({
      id: tenant.id, name: tenant.name, unit: tenant.unit, phone: tenant.phone,
      opened_on: tenant.openedOn, opening_arrears: tenant.openingArrears,
    }).select().single();
    if (error) throw error;
    await supabase.from('segments').insert(
      tenant.segments.map(s => ({ id: s.id, tenant_id: tenant.id, package: s.package,
        start_date: s.start, end_date: s.end }))
    );
    if (tenant.payments.length) {
      await supabase.from('payments').insert(
        tenant.payments.map(p => ({ id: p.id, tenant_id: tenant.id, date: p.date,
          amount: p.amount, ref: p.ref, note: p.note }))
      );
    }
    return tenant;
  },

  async update(id, patch) {
    const { segments, payments, ...fields } = patch;

    if (segments) {
      // Replace: delete all rows, re-insert. Low traffic, correct and simple.
      await supabase.from('segments').delete().eq('tenant_id', id);
      await supabase.from('segments').insert(
        segments.map(s => ({ tenant_id: id, package: s.package, start_date: s.start, end_date: s.end }))
      );
    }
    if (payments) {
      const { data: existing } = await supabase.from('payments').select('id').eq('tenant_id', id);
      const have = new Set((existing || []).map(p => p.id));
      const del = (existing || []).filter(p => !payments.some(np => np.id === p.id));
      if (del.length) await supabase.from('payments').delete().in('id', del.map(p => p.id));
      for (const p of payments) {
        if (have.has(p.id)) continue; // unchanged
        await supabase.from('payments').insert({ tenant_id: id, date: p.date,
          amount: p.amount, ref: p.ref, note: p.note });
      }
    }

    const dbPatch = {};
    if ('name' in fields) dbPatch.name = fields.name;
    if ('unit' in fields) dbPatch.unit = fields.unit;
    if ('phone' in fields) dbPatch.phone = fields.phone;
    if ('openingArrears' in fields) dbPatch.opening_arrears = fields.openingArrears;

    const { error } = await supabase.from('tenants').update(dbPatch).eq('id', id);
    if (error) throw error;

    const all = await this.getAll();
    return all.find(t => t.id === id);
  },

  async remove(id) {
    // cascade deletes segments + payments
    const { error } = await supabase.from('tenants').delete().eq('id', id);
    if (error) throw error;
    return true;
  },
};
```

Note `openedOn` should never change after creation (it is the tax point for
`opening_arrears`); correct the **first segment's start date** instead, which
is what the Edit form does.

## 5. Operators & team access (live)

Tenants are **customers**; operators are the **people who run the business**
(you + anyone you trust). They never share a table — an operator must never
appear in the Collect list or income report.

```sql
create table public.operators (
  id    uuid primary key references auth.users(id) on delete cascade,
  role  text not null default 'admin' check (role in ('owner','admin')),
  name  text,
  created_at timestamptz not null default now()
);
```

RLS design (migrations `…0001` + `…0002`):

- **Bootstrap:** the first signed-in user inserts themselves as `owner` — the
  insert policy allows it only while the table is empty
  (`public.operator_count() = 0`).
- **Owner power:** `owner` can add (`admin`), remove, and manage operators.
- **Any operator reads the team list** and **manages the whole ledger** — the
  tenants/segments/payments/messages policies now check
  `exists (select 1 from operators …)` instead of `owner_id = auth.uid()`.

> ⚠️ Recursion pitfall (fixed in `…0002`): a policy on `operators` may not
> query `operators` in its own expression — Postgres rejects that with
> "infinite recursion detected". All self-reads go through security-definer
> helpers `public.current_operator_role()` and `public.operator_count()`.
> Cross-table references (e.g. tenants → operators) do not recurse and are
> fine inline.

**Adding a teammate (Settings → Team → Add as admin):** the owner types name,
email + temporary password. The app calls `supabase.auth.signUp` (creating
that auth user), restores the owner's session if the project's email
confirmation is off, then inserts the `operators` row with `role = 'admin'`.
If confirmation is on, the new admin must click the activation email first.
They change their own password from Settings → **Change my password**
(`supabase.auth.updateUser`); forgot-password recovery emails work once the
project has a real site URL configured.

Removing an operator deletes only the `operators` row — their auth account
stays but `ensureOperator()` in `app.js` signs them out on next visit
(`login.html?denied=1`).

## 5b. Audit log, cash payments & new packages (live in migration `…0005`)

- **Packages.** Two monthly tiers were added: `monthly-700` (Sh 700) and
  `monthly-1000` (Sh 1000). The `segments.package` check constraint now accepts
  `daily`, `weekly-180`, `weekly`, `monthly-500`, `monthly-700`, `monthly-1000`,
  `monthly`.
- **Cash payments.** `payments.method` is `'mpesa'` (default) or `'cash'`. When
  you record a cash payment no transaction code is required — the ref is stored
  as `NULL`. The Record payment / Add tenant / Bring-back sheets each have an
  M-Pesa ↔ Cash toggle. Cash payments display as "💵 cash" in both the manager
  and the tenant page.
- **Audit log.** Every ledger action (add, edit, remove, payment, delete
  payment, away, back, access-code create/renew/revoke) writes a row to
  `public.audit_log` (`tenant_name`, `actor`, `unit`, `kind`, `summary`,
  `detail`, `created_at`). The manager's **Audit** tab (bottom nav) shows the
  most recent 60 entries, newest first. Rows are written to Supabase and a
  `localStorage` mirror (`faiba_audit_v1`) is kept so the list still renders if
  the cloud write ever fails; a failed audit write never blocks the action it
  logs.

## 6. Multi-device sync (optional)

Because all money is recomputed from stored facts, realtime is trivial and
safe — a second device simply re-fetches and re-derives:

```js
supabase
  .channel('ledger-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'tenants' }, async () => {
    tenants = await DB.getAll();
    renderAll();
  })
  .subscribe();
```

---

## Phase 2 — tenant logins (letting tenants check their own debt)

Goal: each tenant can open `tenant.html` on their own phone, type the phone
number you have on file plus the access code you generate in their detail
page ("Tenant access"), and see their balance, cycles and payments —
read-only, so "but I paid!" disputes end in seconds without you explaining
the ledger.

**The demo UI already exists and works today.** The manager generates and
revokes per-tenant codes, WhatsApps them a one-tap link
(`tenant.html?phone=…&pin=…`), and has a "Test their page" button
(`tenant.html?demo=1&t=<id>`) for you to preview exactly what each tenant
sees. Both pages share `ledger-core.js`, so the tenant sees the *same*
numbers you see.

> ⚠️ Demo caveats before hosting: the tenant page currently reads the same
device's `localStorage`, and `accessPin` sits in plaintext on the tenant
record so the manager can re-share it. Neither is acceptable once tenants
use their own phones — the hosted schema below fixes both (server-side PIN
verification, hash at rest, RLS). The one-tap WhatsApp link already carries
the right URL shape, so nothing about the flow needs to change. The in-app
inbox + presence mock (keys `faiba_messages_v2` / `faiba_presence_v2` in
localStorage) maps onto a `messages` table with Supabase Realtime channels
for live threads, read receipts and presence — same message shape, same UI.

### PIN handling when hosted

Store only a salted hash, never the plaintext PIN. Use the same recipe as
the admin gate: `sha256(salt + ':' + pin)` with a per-tenant random salt.
`access_pin_hash` and `access_salt` replace the demo's plain `accessPin`.

### Schema changes

```sql
alter table tenants
  add column tenant_user_id uuid unique references auth.users(id),
  add column access_pin_hash text,
  add column access_salt text;

-- Tenant-scoped RLS: a logged-in tenant may SELECT only their own account.
create policy "tenant reads own account" on tenants for select
using (tenant_user_id = auth.uid());

create policy "tenant reads own segments" on segments for select
using (exists (select 1 from tenants t where t.id = segments.tenant_id and t.tenant_user_id = auth.uid()));

create policy "tenant reads own payments" on payments for select
using (exists (select 1 from tenants t where t.id = payments.tenant_id and t.tenant_user_id = auth.uid()));
```

`owner_id` rows are still fully managed by the owner; the new policies only
**add** read access for the tenant whose row points at them. Since policies
are permissive and additive, the owner keeps `for all` on their rows.

### Flow

1. You create a Supabase user per tenant (email + a password you give them),
   then link it: `update tenants set tenant_user_id = '<uuid>' where id = '...'`.
   A "Generate login" button in the app can do both via a Supabase Edge
   Function later — until then, the dashboard works.
2. A second tiny page (`tenant.html`) that loads the same client, signs in,
   and calls `analyze()` on **only their tenant row** to show:
   - balance owed / paid-up / prepaid, in the same visual language;
   - the cycle ledger (what's billed, what's paid);
   - their own payment history with M-Pesa codes;
   - a "notify owner" button that opens WhatsApp with a prefilled message.
3. Tenants can **never write**. All writes stay with the owner, so records
   stay straight.

### Data-model fit

No extra work is needed in the core: the same nested shape + `analyze()`
renders a single-tenant view. `DB.getAll()` becomes owner-only
(`select * where owner_id = auth.uid()`); the tenant page uses
`supabase.from('tenants').select('*').eq('tenant_user_id', auth.uid()).single()`
plus the same mapping.

## What NOT to change

- `ledger-core.js`: `PACKAGES`, `analyze`, `buildCharges`, `simulateClose`,
  `migrateV1`, `normalizePhone` — pure logic shared by both pages.
- Every `render*` function and the DOM event wiring in `app.js` and
  `app-tenant.js`.
- The demo `login.html` gate, `tenant.html`, `index.html` / `style.css` —
  other than the Supabase script tag, an owner login that calls
  `supabase.auth.signInWithPassword`, and the tenant page swapping its local
  data read for a scoped backend read.

## Testing checklist after the swap

- [ ] Add a tenant (with an old start date + arrears) — rows land in
      `tenants`, `segments`, `payments`.
- [ ] Record a partial payment with an M-Pesa ref; `payments` gains one row.
- [ ] Mark a tenant away on a past date; their open segment gets an
      `end_date` and the pro-rata shows on refresh.
- [ ] Bring them back on a different package; a second `segments` row appears.
- [ ] Refresh / open on a second device and confirm the same balances
      (proves auth + RLS are wired).
- [ ] Log in as a different owner user and confirm they see zero tenants.
- [ ] Phase 2: open `tenant.html?demo=1&t=<id>` on the owner device and
      confirm it matches the manager's numbers for that tenant.
- [ ] Log in on `tenant.html` with the right phone + code and confirm only
      that tenant's ledger appears; try a wrong code and confirm it refuses;
      confirm there is no write control anywhere on the page.
- [ ] Revoke a code in the manager and confirm the tenant page then refuses
      that code.
