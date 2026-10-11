/* ===================================================================
   FAIBA LEDGER — ledger-core.js
   -------------------------------------------------------------------
   The pure accounting engine, shared by BOTH pages:
     - index.html  (the reseller's manager, via app.js)
     - tenant.html (a tenant checking their own debt, via app-tenant.js)

   Nothing in this file touches the DOM or storage of one specific page.
   Read the accounting rules below first — everything else derives from
   them.

   RULES
   1. CHARGE WHEN A CYCLE STARTS
      The moment a tenure starts, its first cycle is billed in full.
      Each time a cycle boundary passes while the tenant is active, the
      next cycle is billed too.  Balance = total billed - total paid.
   2. PAYMENTS ARE CREDITS APPLIED OLDEST-FIRST (FIFO)
      Money is credited against the oldest unpaid bill first. Arrears
      across cycles, partial lump-sum payments, and overpayments that
      become prepaid credit all fall out of this naturally.
   3. AWAY PRORATES AND CLOSES THE TENURE
      Marking someone away bills the half-finished cycle only for the
      days actually used (price * days / cycle length) and closes the
      segment. Nothing accrues while away.
   4. COMING BACK STARTS A NEW TENURE
      Returning opens a fresh segment from the arrival date on the
      package chosen then; unpaid debt simply stays on the balance.
   5. OPENING BALANCES
      `openingArrears` is billed once at `openedOn` for debt carried
      from before tracking started.
=================================================================== */

// ---------------------------------------------------------------
// Packages
// ---------------------------------------------------------------
// Seeded defaults — used until the cloud catalogue arrives, and as the
// fallback if it can never be read (offline). The live list is loaded
// into PACKAGES by setPackages(); see app.js.
const DEFAULT_PACKAGES = {
  daily:          { key: 'daily',         label: 'Daily',   price: 30,   days: 1  },
  'weekly-180':   { key: 'weekly-180',    label: 'Weekly',  price: 180,  days: 7  },
  'weekly-210':   { key: 'weekly-210',    label: 'Weekly',  price: 210,  days: 7  },
  'weekly':       { key: 'weekly',        label: 'Weekly',  price: 200,  days: 7  },
  'monthly-500':  { key: 'monthly-500',   label: 'Monthly', price: 500,  days: 30 },
  'monthly-700':  { key: 'monthly-700',   label: 'Monthly', price: 700,  days: 30 },
  'monthly-1000': { key: 'monthly-1000',  label: 'Monthly', price: 1000, days: 30 },
  'monthly':      { key: 'monthly',       label: 'Monthly', price: 800,  days: 30 },
};

// Every package by key — active AND switched off, so a tenant still on a
// switched-off package always prices correctly.
const PACKAGES = Object.assign({}, DEFAULT_PACKAGES);

// Pickers and the Report walk this list: active packages, display order.
const PACKAGE_ORDER = Object.keys(DEFAULT_PACKAGES);

// Install the cloud catalogue. Rows: { key, label, price, days, active,
// sortOrder }. Keeps every package for pricing; exposes only the active
// ones for selection.
function setPackages(list) {
  if (!Array.isArray(list) || !list.length) return;
  for (const k of Object.keys(PACKAGES)) delete PACKAGES[k];
  PACKAGE_ORDER.length = 0;
  for (const p of list) {
    const key = String((p && p.key) || '').trim();
    if (!key) continue;
    PACKAGES[key] = {
      key,
      label: String(p.label || key),
      price: Number(p.price) || 0,
      days: Math.max(1, Math.round(Number(p.days) || 1)),
      active: p.active !== false,
    };
    if (p.active !== false) PACKAGE_ORDER.push(key);
  }
  if (!Object.keys(PACKAGES).length) Object.assign(PACKAGES, DEFAULT_PACKAGES);
  if (!PACKAGE_ORDER.length) {
    for (const k of Object.keys(PACKAGES)) if (PACKAGES[k].active !== false) PACKAGE_ORDER.push(k);
  }
}

// Ordered keys for reporting: active packages first, then any switched
// off package still referenced by history.
function packageKeysOrdered() {
  const keys = PACKAGE_ORDER.slice();
  for (const k of Object.keys(PACKAGES)) if (keys.indexOf(k) === -1) keys.push(k);
  return keys;
}

function pkgOf(key) {
  return PACKAGES[key]
    || PACKAGES[PACKAGE_ORDER[0]]
    || DEFAULT_PACKAGES['weekly']
    || { key: key || 'custom', label: key || 'Custom', price: 0, days: 30 };
}

// The price + cycle-length actually sold on a segment: the frozen
// snapshot when present, otherwise today's catalogue (older rows).
function segPriceDays(seg, pkg) {
  const has = v => v !== null && v !== undefined && v !== '';
  return {
    price: has(seg.price) ? Number(seg.price) : pkg.price,
    days: has(seg.days) ? Math.max(1, Math.round(Number(seg.days))) : pkg.days,
  };
}

// ---------------------------------------------------------------
// Date helpers (stored as 'YYYY-MM-DD', local calendar)
// ---------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;

function toLocalIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayStr() { return toLocalIso(new Date()); }
function dayMs(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function addDays(str, n) {
  return toLocalIso(new Date(dayMs(str) + n * DAY_MS));
}
function fmtDate(msOrStr, withYear) {
  const d = typeof msOrStr === 'number' ? new Date(msOrStr) : new Date(dayMs(msOrStr));
  const opts = { day: 'numeric', month: 'short' };
  if (withYear) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}
function relDay(str) {
  const diff = Math.round((dayMs(str) - dayMs(todayStr())) / DAY_MS);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return diff > 0 ? `in ${diff}d` : `${-diff}d ago`;
}

// ---------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------
function nowIso() { return new Date().toISOString(); }
function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}
function money(n) {
  const v = Math.round(Number(n) || 0);
  return 'Sh ' + v.toLocaleString('en-KE');
}
function fmtMoneyOnly(n) {
  return (Math.round(Number(n) || 0)).toLocaleString('en-KE');
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function normalizePhone(raw) {
  if (!raw) return '';
  let d = String(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('0')) d = '254' + d.slice(1);
  else if (/^[17]/.test(d)) d = '254' + d;
  return d;
}

// ---------------------------------------------------------------
// Storage keys shared by manager and tenant page
// ---------------------------------------------------------------
const STORAGE_KEY = 'faiba_ledger_tenants_v2';
const LEGACY_KEY = 'faiba_ledger_tenants_v1';

// One-time upgrade from the v1 model. v1 data has no per-cycle billing
// history, so we reconstruct it preserving the number the old app
// displayed ("owed") exactly: all payments are kept as credits and one
// opening charge of  payments-so-far + old owed  is added, so the net
// balance equals the old owed figure while every payment stays visible.
function migrateV1(list) {
  return list.map(t => {
    const pkg = pkgOf(t.package);
    const payments = (t.payments || []).map(p => ({
      id: p.id || uid(),
      date: toLocalIso(new Date(p.date)),
      amount: Number(p.amount) || 0,
      ref: p.ref || '',
      note: p.note || '',
    }));
    const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
    const oldOwed = Math.max(0, (Number(t.price) || pkg.price) - (Number(t.amountPaid) || 0));
    const wasActive = t.status === 'active';
    const anchor = wasActive && t.cycleStart ? toLocalIso(new Date(t.cycleStart)) : todayStr();
    return {
      id: t.id || uid(),
      name: t.name || 'Tenant',
      unit: t.unit || '',
      phone: t.phone || '',
      openedOn: anchor,
      openingArrears: Math.max(0, paidTotal + oldOwed),
      segments: [{
        id: uid(),
        package: pkg.key,
        start: anchor,
        end: wasActive ? null : anchor,
      }],
      payments,
      createdAt: t.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
  });
}

// Load the raw tenant list, migrating v1 if that is what exists.
function loadTenantList() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) return JSON.parse(raw);
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (!legacy) return [];
  const migrated = migrateV1(JSON.parse(legacy));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
  return migrated;
}

// ---------------------------------------------------------------
// THE ACCOUNTING ENGINE — pure, recomputed from stored facts
// ---------------------------------------------------------------
function activeSegment(t) {
  return (t.segments || []).find(s => !s.end);
}
function isAway(t) { return !activeSegment(t); }
function latestSeg(t) { return (t.segments || [])[t.segments.length - 1]; }

function buildCharges(t, refMs) {
  const charges = [];
  if (Number(t.openingArrears) > 0) {
    charges.push({
      kind: 'opening',
      date: dayMs(t.openedOn),
      amount: Math.round(Number(t.openingArrears)),
      label: 'Opening balance',
      sub: `Debt from before ${fmtDate(t.openedOn)}`,
    });
  }
  (t.segments || []).forEach((seg, si) => {
    const pkg = pkgOf(seg.package);
    const S = dayMs(seg.start);
    const E = seg.end ? dayMs(seg.end) : refMs;
    if (E < S) return;
    const elapsed = Math.floor((E - S) / DAY_MS);
    const { price: C, days: D } = segPriceDays(seg, pkg);
    const segTag = t.segments.length > 1 ? ` (tenure ${si + 1})` : '';

    if (!seg.end) {
      const started = Math.floor(elapsed / D) + 1;
      for (let k = 0; k < started; k++) {
        const cStart = S + k * D;
        const cEnd = S + (k + 1) * D - DAY_MS;
        charges.push({
          kind: 'cycle',
          date: cStart,
          amount: C,
          label: `Cycle ${k + 1}${segTag}`,
          sub: D === 1 ? fmtDate(cStart) : `${fmtDate(cStart)} – ${fmtDate(cEnd)}`,
        });
      }
    } else {
      const full = Math.floor(elapsed / D);
      const rem = elapsed - full * D;
      for (let k = 0; k < full; k++) {
        const cStart = S + k * D;
        const cEnd = S + (k + 1) * D - DAY_MS;
        charges.push({
          kind: 'cycle',
          date: cStart,
          amount: C,
          label: `Cycle ${k + 1}${segTag}`,
          sub: D === 1 ? fmtDate(cStart) : `${fmtDate(cStart)} – ${fmtDate(cEnd)}`,
        });
      }
      if (rem > 0) {
        const cStart = S + full * D;
        const amount = Math.round((C * rem) / D);
        charges.push({
          kind: 'partial',
          date: cStart,
          amount,
          label: `Away partial${segTag}`,
          sub: `Billed ${rem} of ${D} days · left ${fmtDate(seg.end)}`,
          daysUsed: rem,
          cycleDays: D,
        });
      }
    }
  });
  charges.forEach((c, i) => { c.seq = i; c.covered = 0; });
  return charges;
}

// Full financial picture for a tenant as of today.
function analyze(t, refStr) {
  const ref = refStr ? dayMs(refStr) : dayMs(todayStr());
  const charges = buildCharges(t, ref);
  const payments = [...(t.payments || [])].map((p, i) => ({ ...p, amount: Number(p.amount) || 0, seq: i }));

  charges.sort((a, b) => (a.date - b.date) || (a.seq - b.seq));
  payments.sort((a, b) => (dayMs(a.date) - dayMs(b.date)) || (a.seq - b.seq));

  // FIFO: each payment credits the OLDEST unpaid bill first.
  let ci = 0;
  for (const p of payments) {
    let rem = p.amount;
    while (rem > 0 && ci < charges.length) {
      const c = charges[ci];
      const need = c.amount - c.covered;
      if (need <= 0) { ci++; continue; }
      const take = Math.min(need, rem);
      c.covered += take;
      rem -= take;
      if (c.covered >= c.amount) ci++;
    }
  }

  const totalBilled = charges.reduce((s, c) => s + c.amount, 0);
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  const balance = totalBilled - totalPaid;
  const owed = Math.max(0, balance);
  const credit = Math.max(0, -balance);

  const unpaid = charges.filter(c => c.covered < c.amount);
  const fullUnpaid = unpaid.filter(c => c.kind === 'cycle').length;
  const partialUnpaid = unpaid.some(c => c.kind === 'partial');
  const openingUnpaid = unpaid.some(c => c.kind === 'opening');

  let next = null;
  const seg = activeSegment(t);
  if (seg) {
    const pkg = pkgOf(seg.package);
    const { price: dprice, days: ddays } = segPriceDays(seg, pkg);
    const S = dayMs(seg.start);
    const elapsed = Math.floor((ref - S) / DAY_MS);
    const started = Math.floor(elapsed / ddays) + 1;
    const curStart = S + (started - 1) * ddays * DAY_MS;
    const nextStart = S + started * ddays * DAY_MS;
    const progress = Math.min(1, Math.max(0, (ref - curStart) / (ddays * DAY_MS)));
    next = {
      amount: dprice,
      start: curStart,
      boundary: nextStart,
      dateLabel: fmtDate(nextStart),
      daysLeft: Math.max(0, Math.ceil((nextStart - ref) / DAY_MS)),
      progress,
      cycleNo: started,
      pkg: Object.assign({}, pkg, { price: dprice, days: ddays }),
    };
  }

  let owedNote = '';
  if (owed > 0) {
    const parts = [];
    if (fullUnpaid > 0) parts.push(`${fullUnpaid} cycle${fullUnpaid === 1 ? '' : 's'} unpaid`);
    if (partialUnpaid) parts.push('partial cycle');
    if (openingUnpaid) parts.push('opening balance');
    owedNote = parts.length ? parts.join(' + ') : 'outstanding';
  }

  return {
    charges, payments,
    totalBilled, totalPaid,
    balance, owed, credit,
    unpaidCount: unpaid.length,
    fullUnpaid, partialUnpaid, openingUnpaid,
    owedNote,
    state: owed > 0 ? 'owed' : (credit > 0 ? 'credit' : 'clear'),
    deepArrears: owed > 0 && (fullUnpaid + (partialUnpaid ? 1 : 0) + (openingUnpaid ? 1 : 0)) >= 2,
    next,
    seg,
    awaySince: isAway(t) ? latestSeg(t).end : null,
  };
}

// What the balance WOULD be if the open tenure closed on closeStr.
function simulateClose(t, closeStr) {
  const copy = clone(t);
  const seg = activeSegment(copy);
  if (!seg) return analyze(copy);
  seg.end = closeStr;
  return analyze(copy);
}

// ---------------------------------------------------------------
// Messaging + presence (LOCAL MOCK of the hosted feature)
// ---------------------------------------------------------------
// Shared by both pages so an "inbox" written on tenant.html shows up in
// the manager. When this is hosted, the same keys become Supabase
// Realtime channels and the mock write-through below is replaced.
const MESSAGES_KEY = 'faiba_messages_v2';
const PRESENCE_KEY = 'faiba_presence_v2';
const ONLINE_WINDOW_MS = 25000;

function loadMessages() {
  try { return JSON.parse(localStorage.getItem(MESSAGES_KEY)) || []; } catch (e) { return []; }
}
function saveMessages(list) {
  localStorage.setItem(MESSAGES_KEY, JSON.stringify(list));
  return list;
}
function loadPresence() {
  try { return JSON.parse(localStorage.getItem(PRESENCE_KEY)) || {}; } catch (e) { return {}; }
}
function savePresence(p) {
  localStorage.setItem(PRESENCE_KEY, JSON.stringify(p));
  return p;
}
function isOnline(ts) {
  return typeof ts === 'number' && (Date.now() - ts) < ONLINE_WINDOW_MS;
}
function fmtAgo(ts) {
  if (!ts) return 'never online';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s <= 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

// ---------------------------------------------------------------
// Conversation deletion — one party at a time.
// ---------------------------------------------------------------
// A thread can be deleted on EACH side independently: "delete" only
// hides it for the person who deletes, and never touches the other
// side's copy. Sides are 'owner' and 'tenant'. A fresh incoming
// message clears the delete marker so the thread comes back for the
// person it's addressed to.
const DELETED_KEY = 'faiba_deleted_threads_v2';

function loadDeletedThreads() {
  try { return JSON.parse(localStorage.getItem(DELETED_KEY)) || {}; } catch (e) { return {}; }
}
function saveDeletedThreads(obj) {
  localStorage.setItem(DELETED_KEY, JSON.stringify(obj));
  return obj;
}
function threadDeletedFor(tenantId, side) {
  const d = loadDeletedThreads();
  return !!(d[tenantId] && d[tenantId][side]);
}
function deleteThreadFor(tenantId, side) {
  const d = loadDeletedThreads();
  d[tenantId] = d[tenantId] || {};
  d[tenantId][side] = Date.now();
  saveDeletedThreads(d);
}
function clearThreadDeletedFor(tenantId, side) {
  const d = loadDeletedThreads();
  if (d[tenantId] && d[tenantId][side]) {
    delete d[tenantId][side];
    if (!Object.keys(d[tenantId]).length) delete d[tenantId];
    saveDeletedThreads(d);
  }
}
// A fresh message restarts the conversation for everyone: whichever
// side deleted their view gets it back when the other side writes.
function noteNewMessage(tenantId) {
  const d = loadDeletedThreads();
  if (d[tenantId]) { delete d[tenantId]; saveDeletedThreads(d); }
}
