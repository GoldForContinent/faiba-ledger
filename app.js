/* ===================================================================
   FAIBA LEDGER — app.js (reseller manager)
   -------------------------------------------------------------------
   Load AFTER ledger-core.js. This file is the manager UI for the
   owner: views, sheets, forms, WhatsApp, and the tenant access-code
   controls. The accounting rules live in ledger-core.js.

   Storage: only this file and ledger-core talk to localStorage, and
   only ledger-core's `loadTenantList`/`migrateV1` read tenant rows.
   The `DB` object is the seam a future Supabase backend replaces
   (see SUPABASE_INTEGRATION.md).
=================================================================== */

// ---------------------------------------------------------------
// Supabase client + local demo sidecars
// ---------------------------------------------------------------
const OWNER_KEY = 'faiba_owner_phone_v1';
const PIN_KEY = 'faiba_access_pins_v1'; // tenant access codes stay on-device until Phase 2

initSupabaseClient();
function goLogin() { location.replace('login.html'); }
function loadPins() { try { return JSON.parse(localStorage.getItem(PIN_KEY)) || {}; } catch (e) { return {}; } }
function savePins(p) { localStorage.setItem(PIN_KEY, JSON.stringify(p)); }
function writePin(id, pin) {
  const p = loadPins();
  if (pin === null) delete p[id]; else p[id] = pin;
  savePins(p);
}

// Access codes are hashed server-side (owner_set_pin stores
// sha256(salt || ':' || pin)); the plaintext never touches the DB.
// The random salt is generated here so no helper is needed remotely.
function randSalt() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function pushPin(id, pin) {
  if (pin === null || pin === undefined) {
    await supabaseClient.rpc('owner_clear_pin', { p_tenant_id: id });
  } else {
    await supabaseClient.rpc('owner_set_pin', { p_tenant_id: id, p_salt: randSalt(), p_pin: String(pin) });
  }
}
// Codes created before the cloud wiring only live in this device's
// localStorage. Sweep any that aren't hashed in the cloud yet so
// existing links start working again without regenerating codes.
async function syncLocalPinsToCloud() {
  const pins = loadPins();
  const ids = Object.keys(pins);
  if (!ids.length) return;
  const { data: rows, error } = await supabaseClient.from('tenants').select('id, access_salt').in('id', ids);
  if (error || !rows) return;
  const pushed = new Set(rows.filter(r => r.access_salt).map(r => r.id));
  for (const id of ids) {
    if (pushed.has(id)) continue;
    try { await pushPin(id, pins[id]); } catch (e) { /* try the rest; next visit heals */ }
  }
}

// ---------------------------------------------------------------
// Data layer — Supabase (row-level security protects every row).
// ---------------------------------------------------------------
async function insertSegments(tenantId, segments) {
  if (!segments || !segments.length) return;
  const { error } = await supabaseClient.from('segments').insert(
    segments.map(s => ({
      tenant_id: tenantId,
      package: s.package,
      start_date: s.start,
      end_date: s.end || null,
      // Frozen snapshot of what was sold on this tenure. null means the
      // row predates snapshots and the catalogue price applies.
      price: s.price === undefined ? null : s.price,
      days: s.days === undefined ? null : s.days,
    }))
  );
  if (error) throw error;
}
async function insertPayments(tenantId, payments) {
  if (!payments || !payments.length) return;
  const { error } = await supabaseClient.from('payments').insert(
    payments.map(p => ({
      id: p.id,
      tenant_id: tenantId,
      date: p.date,
      amount: Number(p.amount),
      ref: (p.method === 'cash' ? null : (p.ref || null)),
      method: p.method || 'mpesa',
      note: p.note || null,
      recorded_by: p.recorded_by || auditOperatorName() || null,
    }))
  );
  if (error) throw error;
}
async function syncPayments(tenantId, payments) {
  const { data: existing } = await supabaseClient.from('payments').select('*').eq('tenant_id', tenantId);
  const rows = existing || [];
  const current = new Map(rows.map(r => [r.id, r]));
  const want = new Set((payments || []).map(p => p.id));
  const del = rows.filter(r => !want.has(r.id));
  if (del.length) {
    const { error } = await supabaseClient.from('payments').delete().in('id', del.map(r => r.id));
    if (error) throw error;
  }
  for (const p of payments || []) {
    const row = {
      date: p.date,
      amount: Number(p.amount),
      ref: (p.method === 'cash' ? null : (p.ref || null)),
      method: p.method || 'mpesa',
      note: p.note || null,
      recorded_by: p.recorded_by || auditOperatorName() || null,
    };
    const cur = current.get(p.id);
    if (cur) {
      const changed = cur.date !== row.date
        || Number(cur.amount) !== row.amount
        || (cur.ref || null) !== row.ref
        || (cur.method || 'mpesa') !== row.method
        || (cur.note || null) !== row.note
        || (cur.recorded_by || null) !== row.recorded_by;
      if (changed) {
        const { error } = await supabaseClient.from('payments').update(row).eq('id', p.id);
        if (error) throw error;
      }
    } else {
      const { error } = await supabaseClient.from('payments').insert({ id: p.id, tenant_id: tenantId, ...row });
      if (error) throw error;
    }
  }
}

// Every write to the ledger ends up in one of the three DB methods below, so
// this is the one place that can refuse a change while the signal is gone.
// A balance that cannot be saved is worse than one that is late: nothing is
// written offline, and the owner is told why in their own words.
function requireCloud() {
  if (navigator.onLine !== false) return;
  const err = new Error('offline');
  err.offline = true;
  toast('You are offline — nothing was changed. Reconnect and try again.');
  throw err;
}

const DB = {
  async getAll() {
    const [{ data: rows, error: tErr }, { data: segs, error: sErr }, { data: pays, error: pErr }] = await Promise.all([
      supabaseClient.from('tenants').select('*').order('created_at'),
      supabaseClient.from('segments').select('*'),
      supabaseClient.from('payments').select('*'),
    ]);
    if (tErr) throw tErr;
    if (sErr) throw sErr;
    if (pErr) throw pErr;
    const pins = loadPins();
    return (rows || []).map(row => ({
      id: row.id,
      name: row.name,
      unit: row.unit,
      phone: row.phone || '',
      openedOn: row.opened_on,
      openingArrears: Number(row.opening_arrears) || 0,
      accessPin: pins[row.id] || null,
      segments: (segs || [])
        .filter(s => s.tenant_id === row.id)
        .map(s => ({
          id: s.id, package: s.package, start: s.start_date, end: s.end_date,
          price: s.price === null ? null : Number(s.price),
          days: s.days === null ? null : Number(s.days),
        })),
      payments: (pays || [])
        .filter(p => p.tenant_id === row.id)
        .map(p => ({ id: p.id, date: p.date, amount: Number(p.amount), ref: p.ref || '', method: p.method || 'mpesa', note: p.note || '', recorded_by: p.recorded_by || '' })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  },
  async save(list) { return list; }, // interface compat — no longer used
  async insert(tenant) {
    requireCloud();
    const { error: tErr } = await supabaseClient.from('tenants').insert({
      id: tenant.id, name: tenant.name, unit: tenant.unit, phone: tenant.phone || null,
      opened_on: tenant.openedOn, opening_arrears: tenant.openingArrears,
    });
    if (tErr) throw tErr;
    await insertSegments(tenant.id, tenant.segments);
    await insertPayments(tenant.id, tenant.payments);
    return tenant;
  },
  async update(id, patch) {
    requireCloud();
    const { segments, payments, ...fields } = patch;
    if (segments) {
      await supabaseClient.from('segments').delete().eq('tenant_id', id);
      await insertSegments(id, segments);
    }
    if (payments) await syncPayments(id, payments);
    const dbPatch = {};
    if ('name' in fields) dbPatch.name = fields.name;
    if ('unit' in fields) dbPatch.unit = fields.unit;
    if ('phone' in fields) dbPatch.phone = fields.phone;
    if ('openingArrears' in fields) dbPatch.opening_arrears = fields.openingArrears;
    if (Object.keys(dbPatch).length) {
      const { error } = await supabaseClient.from('tenants').update(dbPatch).eq('id', id);
      if (error) throw error;
    }
    const all = await this.getAll();
    return all.find(t => t.id === id);
  },
  async remove(id) {
    requireCloud();
    // .select() after delete returns the rows actually removed. A blocked
    // delete (RLS, or already gone) returns none — surface that instead of
    // pretending success and letting the row reappear on the next refresh.
    const { data, error } = await supabaseClient
      .from('tenants').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data || !data.length) {
      const err = new Error('That tenant no longer exists in the cloud.');
      err.notFound = true;
      throw err;
    }
    return true;
  },

  // ---- packages: the catalogue Settings edits -----------------------
  async getPackages() {
    const { data, error } = await supabaseClient
      .from('packages').select('*').order('sort_order');
    if (error) throw error;
    return (data || []).map(r => ({
      key: r.key, label: r.label, price: Number(r.price), days: Number(r.days),
      active: r.active !== false, sortOrder: r.sort_order,
    }));
  },
  async addPackage(p) {
    requireCloud();
    const { error } = await supabaseClient.from('packages').insert({
      key: p.key, label: p.label, price: p.price, days: p.days,
      active: true, sort_order: p.sortOrder || 100,
    });
    if (error) throw error;
  },
  async updatePackage(key, patch) {
    requireCloud();
    const row = {};
    if ('label' in patch) row.label = patch.label;
    if ('price' in patch) row.price = patch.price;
    if ('days' in patch) row.days = patch.days;
    if ('active' in patch) row.active = patch.active;
    if ('sortOrder' in patch) row.sort_order = patch.sortOrder;
    if (!Object.keys(row).length) return;
    const { error } = await supabaseClient.from('packages').update(row).eq('key', key);
    if (error) throw error;
  },
  async deletePackage(key) {
    requireCloud();
    const { data, error } = await supabaseClient
      .from('packages').delete().eq('key', key).select('key');
    if (error) throw error;
    if (!data || !data.length) throw new Error('That package was not found.');
  },
};

// ---------------------------------------------------------------
// Audit log — a trail of every change made to the ledger.
// Written after each mutation action (who + what + when).
// ---------------------------------------------------------------
const AUDIT_KEY = 'faiba_audit_v1'; // local cache mirror for instant paint

function loadAuditLocal() {
  try { return JSON.parse(localStorage.getItem(AUDIT_KEY)) || []; } catch (e) { return []; }
}
function saveAuditLocal(list) {
  localStorage.setItem(AUDIT_KEY, JSON.stringify(list));
}

function auditIcon(kind) {
  if (kind === 'payment') return '💵';
  if (kind === 'remove') return '🗑️';
  if (kind === 'away') return '🏖️';
  if (kind === 'back') return '🔁';
  if (kind === 'package') return '🔄';
  if (kind === 'edit') return '✏️';
  if (kind === 'access') return '🔑';
  if (kind === 'tenant_view') return '👁️';
  return '📝';
}

function auditOperatorName() {
  if (CURRENT_OPERATOR && CURRENT_OPERATOR.name) return CURRENT_OPERATOR.name;
  if (CURRENT_OPERATOR && CURRENT_OPERATOR.email) return CURRENT_OPERATOR.email;
  if (CURRENT_OPERATOR && CURRENT_OPERATOR.role === 'owner') return 'Owner';
  return 'Admin';
}

// Persist one audit entry to Supabase + the local mirror.
async function writeAudit({ tenantId, tenantName, actor, unit, kind, summary, detail, ts }) {
  const entry = {
    id: uid(),
    tenant_id: tenantId || null,
    tenant_name: tenantName || '',
    actor: actor || auditOperatorName(),
    unit: unit || '',
    kind: kind || 'other',
    summary: summary || '',
    detail: detail || '',
    ts: ts || nowIso(),
  };
  const local = loadAuditLocal();
  local.push(entry);
  saveAuditLocal(local);
  // Fire-and-forget to the cloud; never block the action on it.
  try {
    await supabaseClient.from('audit_log').insert({
      id: entry.id,
      tenant_id: entry.tenant_id,
      tenant_name: entry.tenant_name,
      actor: entry.actor,
      unit: entry.unit,
      kind: entry.kind,
      summary: entry.summary,
      detail: entry.detail,
      created_at: entry.ts,
    });
  } catch (e) { /* audit write failure shouldn't block the action */ }
  return entry;
}

async function loadAudit() {
  const local = loadAuditLocal();
  try {
    const { data, error } = await supabaseClient
      .from('audit_log').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    if (data && data.length) {
      saveAuditLocal(data.map(r => ({
        id: r.id,
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_name,
        actor: r.actor,
        unit: r.unit,
        kind: r.kind,
        summary: r.summary,
        detail: r.detail,
        ts: r.created_at,
      })));
      return data.map(r => ({
        id: r.id,
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_name,
        actor: r.actor,
        unit: r.unit,
        kind: r.kind,
        summary: r.summary,
        detail: r.detail,
        ts: r.created_at,
      }));
    }
  } catch (e) { /* fall through to local mirror */ }
  return [...local].sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

// ---------------------------------------------------------------
// App state
// ---------------------------------------------------------------
let tenants = [];
let view = 'tenants';            // 'tenants' | 'inbox' | 'collect' | 'report' | 'audit'
let filter = 'all';              // all | active | away | owing
let auditFilter = 'all';         // all | tenant
let search = '';
let detailId = null;             // tenant whose detail sheet is open
let reportMode = 'month';        // 'month' | 'all'
let CURRENT_OPERATOR = null;     // { id, role: 'owner'|'admin', name } — who is signed in

// The signed-in user must be an operator (owner or admin). The very first
// person to sign in self-registers as owner; everyone after is added by
// the owner. Returns false if the account isn't an operator.
// The signed-in user must be an operator (owner or admin). The very first
// person to sign in self-registers as owner; everyone after is added by the
// owner.
//
// Three answers, not two: 'denied' means the account is not an operator and
// must be turned away, but 'offline' means we simply could not ask. An
// installed app gets opened with no signal all the time, and signing the
// owner out with "you are not an operator" because the router was down would
// be the one thing worse than not working.
async function ensureOperator() {
  const { data: { user }, error: uErr } = await supabaseClient.auth.getUser();
  if (uErr) return 'offline';
  if (!user) return 'denied';
  const { data: row, error: rErr } = await supabaseClient
    .from('operators').select('role, name').eq('id', user.id).maybeSingle();
  if (rErr) return 'offline';
  if (row) {
    CURRENT_OPERATOR = { id: user.id, role: row.role, name: row.name || '', email: user.email || '' };
    return 'operator';
  }
  const ins = await supabaseClient.from('operators').insert({ id: user.id, role: 'owner' });
  if (ins.error) return navigator.onLine === false ? 'offline' : 'denied';
  CURRENT_OPERATOR = { id: user.id, role: 'owner', name: '', email: user.email || '' };
  return 'operator';
}

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------
// Persistence wrappers
// ---------------------------------------------------------------
// The tenant page reads from localStorage (loadTenantList), so every
// DB write must also push to localStorage so the tenant page sees it.
function syncToLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tenants));
}
async function persistTenant(t) {
  const updated = await DB.update(t.id, t);
  Object.assign(t, updated);
  syncToLocal();
}
async function saveAll() {
  await DB.save(tenants);
  syncToLocal();
}

// Deleting a tenant must leave nothing behind on THIS device either: the
// access code, the chat thread and the presence flag are local sidecars
// that the cloud cascade cannot reach.
function purgeTenantLocals(id) {
  try {
    writePin(id, null);
    saveMessages(loadMessages().filter(m => m.tenantId !== id));
    const p = loadPresence();
    if (p && p.tenants) delete p.tenants[id];
    savePresence(p && p.tenants ? p : { tenants: {} });
  } catch (e) { /* best effort — the cloud row is already gone */ }
}

// ---------------------------------------------------------------
// Packages — the catalogue Settings edits
// ---------------------------------------------------------------
// The package list is a table now, not code. Load it at startup and after
// every change; PACKAGES/PACKAGE_ORDER (ledger-core.js) then price every
// tenant. The manager keeps ALL packages (so a switched-off one still
// prices the tenants on it); the pickers show the active ones only.
async function refreshPackages() {
  try {
    const list = await DB.getPackages();
    if (list.length) setPackages(list);
  } catch (e) { /* offline — the seeded defaults stand in */ }
  renderPackagePickers();
}

// Fill the package radio groups from the live catalogue, preserving the
// current selection where there is one. Only the options are replaced —
// the <legend> stays put.
function renderPackagePickers() {
  document.querySelectorAll('.pkg-picker').forEach(box => {
    const name = box.dataset.name;
    if (!name) return;
    const prev = box.querySelector('input:checked');
    const keep = prev ? prev.value : null;
    box.querySelectorAll('.pkg-option').forEach(el => el.remove());
    box.insertAdjacentHTML('beforeend', PACKAGE_ORDER.map(key => {
      const p = PACKAGES[key];
      return `<label class="pkg-option"><input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(key)}"><span class="pkg-card"><strong>${escapeHtml(p.label)}</strong><em>${money(p.price)}</em></span></label>`;
    }).join(''));
    const inputs = box.querySelectorAll('input');
    if (!inputs.length) return;
    const target = keep && box.querySelector(`input[value="${keep}"]`);
    (target || inputs[0]).checked = true;
  });
}

// ---------------------------------------------------------------
// Owner settings
// ---------------------------------------------------------------
function getOwnerPhone() { return localStorage.getItem(OWNER_KEY) || ''; }
function setOwnerPhone(v) { localStorage.setItem(OWNER_KEY, String(v || '').trim()); }

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
// Is the copy on this device the same as the ledger in the cloud?
let cloudFresh = true;

// Supabase retries a failing request a few times before admitting defeat,
// which on a weak signal means staring at a blank page for half a minute.
// Anything we cannot answer quickly is treated as "no answer", never as a
// no - a wrong "no" signs the owner out of their own ledger.
function withDeadline(work, ms) {
  let timer;
  const guarded = Promise.resolve(work).catch(() => null);
  return Promise.race([
    guarded,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); }),
  ]).then(v => { clearTimeout(timer); return v; });
}

async function init() {
  const { data: sess } = await supabaseClient.auth.getSession();
  if (!sess || !sess.session) { goLogin(); return; }

  // The sign-in token lives on the device, so it still counts with no signal.
  // The operator check does not - if it cannot be answered, carry on with
  // the copy saved here rather than turning the owner away.
  const reachable = navigator.onLine !== false;
  const standing = reachable ? (await withDeadline(ensureOperator(), 8000)) || 'offline' : 'offline';
  if (standing === 'denied') {
    try { await supabaseClient.auth.signOut(); } catch (e) { /* leave anyway */ }
    location.replace('login.html?denied=1');
    return;
  }

  const fresh = standing === 'offline' ? null : await withDeadline(DB.getAll(), 10000);
  if (fresh) {
    tenants = fresh;
    syncToLocal();
    cloudFresh = true;
    setTimeout(() => { syncLocalPinsToCloud().catch(() => {}); }, 0);
  } else {
    // No connection, or the ledger could not be read in time. The last copy
    // on this device stands in; pwa.js is showing the offline strip and
    // watchCloud() puts the real numbers back as soon as it can.
    tenants = loadTenantList();
    cloudFresh = false;
  }

  renderAll();
  await withDeadline(refreshPackages(), 8000);
  renderPackagePickers();
  touchOwner();
  inboxPulse();
  setInterval(() => { renderAll(); }, 30000); // keeps clocks + cycle rolls fresh
  setInterval(inboxPulse, 5000);             // catches new messages + presence changes
  setInterval(touchOwner, 12000);            // "owner online" heartbeat
  window.addEventListener('storage', e => {
    if (e.key === MESSAGES_KEY || e.key === PRESENCE_KEY) { inboxPulse(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) touchOwner(); });
  wireEvents();
  watchCloud();
  handleLaunchAction();
}

// ---------------------------------------------------------------
// Coming back online
// ---------------------------------------------------------------
// navigator.onLine only knows about the network adapter, not about whether
// anything answers on the other end, so a reconnect is confirmed by reading
// the ledger again rather than trusted to the event. One pull at a time:
// a slow attempt must not stack up behind the next tick.
let pulling = false;
async function pullFromCloud() {
  if (pulling) return false;
  pulling = true;
  try {
    const fresh = await withDeadline(DB.getAll(), 10000);
    if (!fresh) { cloudFresh = false; return false; }
    tenants = fresh;
    syncToLocal();
    cloudFresh = true;
    renderAll();
    return true;
  } finally {
    pulling = false;
  }
}

function watchCloud() {
  const catchUp = async () => {
    if (cloudFresh) return;
    if (await pullFromCloud()) toast('Back online — the ledger is up to date.');
  };
  window.addEventListener('online', catchUp);
  setInterval(catchUp, 20000);
}

// The manifest's home-screen shortcuts (Add tenant / Collect) open the
// app with ?action=... - jump straight there, then tidy the address bar
// so a refresh does not repeat it.
function handleLaunchAction() {
  const action = new URLSearchParams(location.search).get('action');
  if (!action) return;
  if (history.replaceState) history.replaceState(null, '', location.pathname);
  if (action === 'add') { openAddSheet(); return; }
  if (action === 'collect') {
    const tab = document.querySelector('.nav-tab[data-tab="collect"]');
    if (tab) tab.click();
  }
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------
function renderAll() {
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('is-active', b.dataset.tab === view));
  $('view-tenants').hidden = view !== 'tenants';
  $('view-inbox').hidden = view !== 'inbox';
  $('view-collect').hidden = view !== 'collect';
  $('view-report').hidden = view !== 'report';
  $('view-audit').hidden = view !== 'audit';

  const owingCount = tenants.filter(t => analyze(t).owed > 0).length;
  const badge = $('collectBadge');
  badge.textContent = owingCount;
  badge.hidden = owingCount === 0;

  renderHero();
  renderTenantList();
  if (view === 'inbox') renderInbox();
  renderCollect();
  renderReport();
  if (view === 'audit') renderAudit();
  if (detailId) {
    const t = tenants.find(x => x.id === detailId);
    if (t) {
      if ($('detailSheet').classList.contains('is-open')) renderDetail(t);
    } else {
      detailId = null;
    }
  }
}

// ---- hero strip --------------------------------------------------
function renderHero() {
  const active = tenants.filter(t => !isAway(t)).length;
  const away = tenants.length - active;
  const monthStart = toLocalIso(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  let collected = 0, owedNow = 0;
  for (const t of tenants) {
    const a = analyze(t);
    for (const p of t.payments || []) if (p.date >= monthStart) collected += Number(p.amount) || 0;
    owedNow += a.owed;
  }
  const tiles = [
    { v: tenants.length, l: 'On the line' },
    { v: active, l: 'Active' },
    { v: money(owedNow), l: 'Owed to you now', cls: owedNow > 0 ? 'hot' : '' },
    { v: money(collected), l: `Collected this month`, cls: collected > 0 ? 'up' : '' },
  ];
  $('heroTiles').innerHTML = tiles.map((t, i) => `
    <div class="tile" style="animation-delay:${i * 40}ms">
      <span class="tile-value ${t.cls || ''}">${t.v}</span>
      <span class="tile-label">${t.l}</span>
    </div>`).join('');
  $('todayChip').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// ---- tenants list ------------------------------------------------
function renderTenantList() {
  const list = $('tenantList');
  const empty = $('tenantEmpty');
  const noMatch = $('tenantNoMatch');

  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('is-active', c.dataset.f === filter));

  let rows = [...tenants];
  if (filter === 'active') rows = rows.filter(t => !isAway(t));
  if (filter === 'away') rows = rows.filter(isAway);
  if (filter === 'owing') rows = rows.filter(t => analyze(t).owed > 0);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    rows = rows.filter(t =>
      t.name.toLowerCase().includes(q) || t.unit.toLowerCase().includes(q) || (t.phone || '').includes(q));
  }
  rows.sort((a, b) => {
    const ka = analyze(a), kb = analyze(b);
    if ((ka.owed > 0) !== (kb.owed > 0)) return ka.owed > 0 ? -1 : 1;
    return a.unit.localeCompare(b.unit) || a.name.localeCompare(b.name);
  });

  empty.hidden = tenants.length !== 0;
  if (tenants.length === 0) { list.innerHTML = ''; noMatch.hidden = true; return; }
  noMatch.hidden = rows.length !== 0;
  if (rows.length === 0) { list.innerHTML = ''; return; }

  list.innerHTML = rows.map((t, i) => tenantCard(t, analyze(t), i)).join('');

  list.querySelectorAll('.trow').forEach(el => {
    const id = el.dataset.id;
    el.addEventListener('click', e => {
      if (e.target.closest('[data-act]')) return;
      openDetail(id);
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') openDetail(id); });
  });
  list.querySelectorAll('[data-act="wa"]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    sendWhatsApp(b.dataset.id);
  }));
}

function tenantCard(t, a, i) {
  const pkg = pkgOf(latestSeg(t).package);
  const away = isAway(t);
  const stateCls = a.state === 'owed' ? (a.deepArrears ? 'is-deep' : 'is-owed') : (a.state === 'credit' ? 'is-credit' : 'is-clear');
  const right = a.state === 'owed'
    ? `<span class="amt amt-owed">${money(a.owed)}</span>
       <span class="amt-cap">${escapeHtml(a.owedNote) || 'owed'}</span>`
    : a.state === 'credit'
      ? `<span class="amt amt-credit">+${money(a.credit)}</span>
         <span class="amt-cap">prepaid credit</span>`
      : `<span class="amt amt-clear">Paid up</span>
         ${a.next ? `<span class="amt-cap">next ${escapeHtml(a.next.dateLabel)} · ${money(a.next.amount)}</span>` : '<span class="amt-cap">all settled</span>'}`;
  const sub = away
    ? `Left ${escapeHtml(fmtDate(a.awaySince))} · ${pkg.label}`
    : `${pkg.label} · on since ${escapeHtml(fmtDate(a.seg.start))}`;

  return `
  <div class="trow ${stateCls}" data-id="${t.id}" role="button" tabindex="0" style="animation-delay:${Math.min(i, 14) * 26}ms">
    <div class="trow-avatar ${away ? 'away' : ''}">${escapeHtml(initials(t.name))}</div>
    <div class="trow-main">
      <div class="trow-top">
        <span class="trow-name">${escapeHtml(t.name)}</span>
        <span class="trow-unit">${escapeHtml(t.unit) || '—'}</span>
      </div>
      <div class="trow-sub">${sub}</div>
    </div>
    <div class="trow-right">
      ${right}
      <div class="trow-btns">
        <button class="icon-btn" data-act="wa" data-id="${t.id}" title="WhatsApp" aria-label="WhatsApp ${escapeHtml(t.name)}">
          ${ICONS.wa}
        </button>
        <span class="dot ${away ? 'away' : (a.state === 'owed' ? 'amber' : 'green')}"></span>
      </div>
    </div>
  </div>`;
}

// ---- collect view ------------------------------------------------
function renderCollect() {
  const list = $('collectList');
  const meta = $('collectMeta');
  const owing = tenants
    .map(t => ({ t, a: analyze(t) }))
    .filter(x => x.a.owed > 0)
    .sort((x, y) => y.a.owed - x.a.owed || x.t.unit.localeCompare(y.t.unit));

  const total = owing.reduce((s, x) => s + x.a.owed, 0);
  meta.innerHTML = owing.length === 0
    ? `<div class="collect-zero">🎉 Everyone is settled. Nothing to collect right now.</div>`
    : `<span class="collect-big">${money(total)}</span>
       <span class="collect-sub">to collect from <b>${owing.length}</b> tenant${owing.length === 1 ? '' : 's'}</span>`;

  list.innerHTML = owing.map(({ t, a }, i) => {
    const pkg = pkgOf(latestSeg(t).package);
    const away = isAway(t);
    return `
    <div class="crow ${a.deepArrears ? 'is-deep' : ''}" style="animation-delay:${Math.min(i, 12) * 30}ms">
      <div class="crow-main" data-open="${t.id}">
        <div class="crow-head">
          <span class="crow-name">${escapeHtml(t.name)}</span>
          <span class="crow-unit">${escapeHtml(t.unit) || '—'}</span>
          ${away ? '<span class="pill pill-away">away</span>' : ''}
          ${a.partialUnpaid ? '<span class="pill pill-partial">partial</span>' : ''}
        </div>
        <div class="crow-sub">${pkg.label} · ${money(pkg.price)}/cycle</div>
      </div>
      <div class="crow-owed">
        <span class="crow-amt">${money(a.owed)}</span>
        <span class="crow-note">${escapeHtml(a.owedNote) || 'owed'}</span>
      </div>
      <div class="crow-actions">
        <button class="btn btn-ghost btn-sm" data-wa="${t.id}" type="button">WhatsApp</button>
        <button class="btn btn-primary btn-sm" data-pay="${t.id}" type="button">Record</button>
      </div>
    </div>`;
  }).join('') || `<p class="dim-empty">No one owes right now.</p>`;

  list.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => openDetail(el.dataset.open)));
  list.querySelectorAll('[data-wa]').forEach(b => b.addEventListener('click', () => sendWhatsApp(b.dataset.wa)));
  list.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', () => openPaymentSheet(b.dataset.pay)));
}

// ---- report view ------------------------------------------------
function renderReport() {
  document.querySelectorAll('#reportChips .chip').forEach(c => c.classList.toggle('is-active', c.dataset.rm === reportMode));

  const now = new Date();
  const monthStart = toLocalIso(new Date(now.getFullYear(), now.getMonth(), 1));

  let collected = 0, billed = 0;
  if (reportMode === 'month') {
    for (const t of tenants) {
      const a = analyze(t);
      for (const p of t.payments || []) if (p.date >= monthStart) collected += Number(p.amount) || 0;
      for (const c of a.charges) if (c.date >= dayMs(monthStart)) billed += c.amount;
    }
  } else {
    for (const t of tenants) {
      const a = analyze(t);
      collected += (t.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      billed += a.totalBilled;
    }
  }
  const outstanding = tenants.reduce((s, t) => s + analyze(t).owed, 0);
  const prepaid = tenants.reduce((s, t) => s + analyze(t).credit, 0);

  $('rCollected').textContent = money(collected);
  $('rOutstanding').textContent = money(outstanding);
  $('rCredit').textContent = money(prepaid);

  const monthLabel = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  $('reportHeadline').textContent = reportMode === 'month' ? monthLabel : 'All time';

  const rate = billed > 0 ? Math.round((collected / billed) * 100) : null;
  $('reportHint').innerHTML = rate === null
    ? 'No bills yet — money starts accruing the day a tenure starts.'
    : `${rate >= 100 ? 'Collection rate' : 'Still collecting'} · you have received ${rate}% of the ${money(billed)} billed${rate >= 100 ? '' : ' so far'}.`;

  const pkgOrder = packageKeysOrdered();
  const rows = pkgOrder.map(key => {
    const pkg = PACKAGES[key];
    const members = tenants.filter(t => latestSeg(t).package === key);
    let mCollected = 0, mOut = 0, mCredit = 0;
    for (const t of members) {
      const a = analyze(t);
      if (reportMode === 'month') {
        for (const p of t.payments || []) if (p.date >= monthStart) mCollected += Number(p.amount) || 0;
      } else {
        mCollected += (t.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      }
      mOut += a.owed;
      mCredit += a.credit;
    }
    return { key, pkg, count: members.length, active: members.filter(t => !isAway(t)).length, collected: mCollected, outstanding: mOut, credit: mCredit };
  }).filter(r => r.count > 0);

  const grid = $('reportGrid');
  grid.innerHTML = rows.length
    ? rows.map((r, i) => `
      <div class="rp-row" style="animation-delay:${Math.min(i, 10) * 30}ms">
        <div class="rp-idx">${pkgOrder.indexOf(r.key) + 1}</div>
        <div class="rp-main">
          <div class="rp-name">${r.pkg.label} <span>${money(r.pkg.price)}</span></div>
          <div class="rp-meta">${r.count} tenant${r.count === 1 ? '' : 's'} · ${r.active} active</div>
        </div>
        <div class="rp-nums">
          <span class="rp-col">${money(r.collected)}</span>
          ${r.outstanding > 0 ? `<span class="rp-out">owes ${money(r.outstanding)}</span>` : `<span class="rp-ok">all paid</span>`}
          ${r.credit > 0 ? `<span class="rp-cr">+${money(r.credit)} ahead</span>` : ''}
        </div>
      </div>`).join('')
    : `<p class="dim-empty">No tenants yet. Add your building and the money map appears here.</p>`;
}

// ---------------------------------------------------------------
// Audit log view
// ---------------------------------------------------------------
async function renderAudit() {
  const box = $('auditList');
  const rows = await loadAudit();
  const shown = auditFilter === 'tenant'
    ? rows.filter(r => r.kind === 'tenant_view').slice(0, 60)
    : rows.slice(0, 60);
  box.innerHTML = shown.length
    ? shown.map((r, i) => {
        const who = r.tenant_name || tenantName(r.tenant_id) || '(removed tenant)';
        const unit = r.unit || '';
        const cls = r.kind === 'payment' ? 'ok'
          : r.kind === 'away' || r.kind === 'remove' ? 'warn'
          : r.kind === 'access' || r.kind === 'tenant_view' ? 'ok'
          : '';
        return `
        <div class="au-row" style="animation-delay:${Math.min(i, 12) * 24}ms">
          <span class="au-ico ${cls}">${auditIcon(r.kind)}</span>
          <div class="au-main">
            <div class="au-title">${escapeHtml(r.summary)}</div>
            ${r.actor ? `<div class="au-actor">${ICONS.op} by <b>${escapeHtml(r.actor)}</b></div>` : ''}
            ${r.detail ? `<div class="au-detail">${escapeHtml(r.detail)}</div>` : ''}
          </div>
          <div class="au-time">${fmtAuditTs(r.ts)}</div>
        </div>`;
      }).join('')
    : auditFilter === 'tenant'
      ? '<p class="dim-empty">No tenant balance views logged yet. When a tenant opens their balance page, it will appear here.</p>'
      : '<p class="dim-empty">No activity logged yet. Changes you make to the ledger will appear here.</p>';
}

function fmtAuditTs(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------
// Detail sheet
// ---------------------------------------------------------------
function openDetail(id) {
  detailId = id;
  const t = tenants.find(x => x.id === id);
  if (!t) return;
  renderDetail(t);
  openSheet('detailSheet');
}

function renderDetail(t) {
  const a = analyze(t);
  const pkg = pkgOf(latestSeg(t).package);
  const away = isAway(t);
  payContextTenantId = t.id; // actions like delete/edit target this tenant

  $('dAvatar').textContent = escapeHtml(initials(t.name));
  $('dAvatar').classList.toggle('away', away);
  $('dName').textContent = t.name;
  $('dUnit').textContent = t.unit || '—';
  $('dPkg').textContent = `${pkg.label} · ${money(pkg.price)}`;
  $('dStatus').textContent = away ? 'AWAY' : 'ACTIVE';
  $('dStatus').className = 'pill pill-status ' + (away ? 'pill-away' : 'pill-active');
  $('dPhone').textContent = t.phone || 'no phone saved — edit to add';

  const sc = $('dStateCard');
  sc.className = 'state-card ' + (a.state === 'owed' ? (a.deepArrears ? 'is-deep' : 'is-owed') : a.state === 'credit' ? 'is-credit' : 'is-clear');
  const stateLabel = a.state === 'owed' ? (a.deepArrears ? 'OWED · MULTIPLE CYCLES' : 'BALANCE OWED') : a.state === 'credit' ? 'PREPAID AHEAD' : 'ALL SETTLED';
  const stateAmt = a.state === 'owed' ? money(a.owed) : a.state === 'credit' ? `+${money(a.credit)}` : money(0);
  const stateCap = a.state === 'owed'
    ? `Billed ${money(a.totalBilled)} · received ${money(a.totalPaid)} · ${escapeHtml(a.owedNote) || 'still owed'}`
    : a.state === 'credit'
      ? `Paid ${money(a.totalPaid)} against ${money(a.totalBilled)} billed — the ${money(a.credit)} credit eats future cycles first`
      : `Billed ${money(a.totalBilled)} · fully covered by ${money(a.totalPaid)} in payments`;
  sc.innerHTML = `
    <div class="state-label">${stateLabel}</div>
    <div class="state-amt">${stateAmt}</div>
    <div class="state-cap">${stateCap}</div>`;

  const tUnread = loadMessages().filter(m => m.tenantId === t.id && m.from === 'tenant' && !m.read).length;
  $('dActions').innerHTML = away ? `
    <button class="btn btn-primary" id="dPay">Record payment</button>
    <button class="btn btn-ghost" id="dBack">Bring back on the line</button>
    <button class="btn btn-icon-text" id="dMsg">💬 Messages${tUnread ? ` · ${tUnread}` : ''}</button>
    <button class="btn btn-icon-text" id="dWa">${ICONS.wa} WhatsApp</button>`
  : `
    <button class="btn btn-primary" id="dPay">Record payment</button>
    <button class="btn btn-ghost" id="dChange">Change package</button>
    <button class="btn btn-ghost" id="dAway">Mark away</button>
    <button class="btn btn-icon-text" id="dMsg">💬 Messages${tUnread ? ` · ${tUnread}` : ''}</button>
    <button class="btn btn-icon-text" id="dWa">${ICONS.wa} WhatsApp</button>`;
  $('dPay').addEventListener('click', () => openPaymentSheet(t.id));
  if (!away) $('dChange').addEventListener('click', () => openChangeSheet(t.id));
  $('dWa').addEventListener('click', () => sendWhatsApp(t.id));
  $('dMsg').addEventListener('click', () => openThreadSheet(t.id));
  if (away) $('dBack').addEventListener('click', () => openBackSheet(t.id));
  else $('dAway').addEventListener('click', () => openAwaySheet(t.id));

  const strip = $('dTenureStrip');
  if (away) {
    const seg = latestSeg(t);
    const days = Math.round((dayMs(seg.end) - dayMs(seg.start)) / DAY_MS);
    const goneDays = Math.max(0, Math.round((dayMs(todayStr()) - dayMs(seg.end)) / DAY_MS));
    strip.innerHTML = `
      <div class="kpi"><span class="kpi-label">Tenure closed</span><span class="kpi-value">${fmtDate(seg.end, true)}</span></div>
      <div class="kpi"><span class="kpi-label">Had been on</span><span class="kpi-value">${days}d · ${pkg.label}</span></div>
      <div class="kpi"><span class="kpi-label">While away</span><span class="kpi-value">${goneDays}d</span></div>`;
  } else if (a.next) {
    const daysOn = Math.max(1, Math.round((dayMs(todayStr()) - dayMs(a.seg.start)) / DAY_MS) + 1);
    strip.innerHTML = `
      <div class="kpi"><span class="kpi-label">On the line since</span><span class="kpi-value">${fmtDate(a.seg.start, true)} · ${daysOn}d</span></div>
      <div class="kpi"><span class="kpi-label">Cycle ${a.next.cycleNo} ends</span><span class="kpi-value">${a.next.dateLabel}</span></div>
      <div class="kpi"><span class="kpi-label">Next charge</span><span class="kpi-value warn-v">${money(a.next.amount)}</span></div>
      <div class="kpi kpi-wide">
        <div class="mini-bar"><i style="width:${Math.round(a.next.progress * 100)}%"></i></div>
        <span class="kpi-cap">${a.next.daysLeft}d left in this cycle — pay before ${a.next.dateLabel}</span>
      </div>`;
  }

  const cxList = $('dCycles');
  const cxSorted = [...a.charges].sort((x, y) => (y.date - x.date) || (y.seq - x.seq));
  const shown = cxSorted.slice(0, 12);
  const hidden = cxSorted.length - shown.length;
  cxList.innerHTML = shown.map(c => {
    const fullyPaid = c.covered >= c.amount;
    const cls = fullyPaid ? 'ok' : c.covered > 0 ? 'part' : 'unpaid';
    const stateHtml = fullyPaid
      ? '<span class="cx-state ok">Paid</span>'
      : c.covered > 0
        ? `<span class="cx-state part">${money(c.covered)} of ${money(c.amount)}</span>`
        : `<span class="cx-state unpaid">${money(c.amount)} unpaid</span>`;
    return `
    <li class="cx-row">
      <span class="cx-dot ${cls}"></span>
      <span class="cx-main">
        <span class="cx-label">${escapeHtml(c.label)}</span>
        <span class="cx-sub">${escapeHtml(c.sub)}</span>
      </span>
      <span class="cx-amt">${money(c.amount)}</span>
      ${stateHtml}
    </li>`;
  }).join('') + (hidden > 0 ? `<li class="cx-more">… and ${hidden} earlier bill${hidden === 1 ? '' : 's'}</li>` : '');

  const pyList = $('dPayments');
  const pays = [...(t.payments || [])].sort((x, y) => (dayMs(y.date) - dayMs(x.date)));
  $('dTotalPaid').textContent = `${money(a.totalPaid)} received in total`;
  pyList.innerHTML = pays.length
    ? pays.map(p => `
      <li class="py-row">
        <span class="py-amt">${money(p.amount)}</span>
        <span class="py-meta">
          <span>${fmtDate(p.date, true)}</span>
          ${p.method === 'cash' ? '<span class="py-ref">💵 cash</span>' : (p.ref ? `<span class="py-ref">M-Pesa · ${escapeHtml(p.ref)}</span>` : '')}
          ${p.recorded_by ? `<span class="py-by">by ${escapeHtml(p.recorded_by)}</span>` : ''}
          ${p.note ? `<span>${escapeHtml(p.note)}</span>` : ''}
        </span>
        <span class="py-btns">
          <button class="py-edit" data-edit-pay="${p.id}" title="Edit payment" aria-label="Edit payment">${ICONS.pencil}</button>
          <button class="py-del" data-del-pay="${p.id}" title="Delete payment" aria-label="Delete payment">${ICONS.x}</button>
        </span>
      </li>`).join('')
    : `<li class="cx-more">No payments recorded yet.</li>`;
  pyList.querySelectorAll('[data-edit-pay]').forEach(b => b.addEventListener('click', () => openEditPayment(t.id, b.dataset.editPay)));
  pyList.querySelectorAll('[data-del-pay]').forEach(b => b.addEventListener('click', () => deletePayment(t.id, b.dataset.delPay)));

  renderAccess(t);
}

// ---- tenant access codes (their self-service login) --------------
function randPin() { return String(Math.floor(1000 + Math.random() * 9000)); }

function tenantLink(id, mode) {
  const t = tenants.find(x => x.id === id);
  if (!t) return '';
  const u = new URL('tenant.html', location.href);
  if (mode === 'demo') {
    u.searchParams.set('demo', '1');
    u.searchParams.set('t', t.id);
  } else {
    u.searchParams.set('phone', String(t.phone || '').trim());
    u.searchParams.set('pin', t.accessPin || '');
  }
  return u.href;
}

function renderAccess(t) {
  const box = $('dAccess');
  const hasPin = !!t.accessPin;
  const hasPhone = !!normalizePhone(t.phone);
  box.innerHTML = `
    <div class="access-head">
      <h3 class="ledger-head">Tenant access <span>their self-service login</span></h3>
      <span class="pill ${hasPin ? 'pill-active' : 'pill-away'}">${hasPin ? 'ACCESS ON' : 'NO CODE'}</span>
    </div>
    ${hasPin ? `
      <div class="pin-row">
        <span class="pin-code">${escapeHtml(t.accessPin)}</span>
        <button class="btn btn-ghost btn-sm" id="daCopy" type="button">Copy</button>
      </div>
      <p class="access-note">${t.phone ? `Shared via WhatsApp to ${escapeHtml(t.phone)} when ready.` : 'Add a phone number to the tenant so they can use the code.'}</p>
      <div class="access-btns">
        <button class="btn btn-ghost btn-sm" id="daRegen" type="button">New code</button>
        ${hasPhone ? `<button class="btn btn-icon-text btn-sm" id="daShare">${ICONS.wa} WhatsApp it</button>` : ''}
        <button class="btn btn-ghost btn-sm" id="daTest" type="button">Test their page</button>
        <button class="btn btn-danger-ghost btn-sm" id="daRevoke" type="button">Revoke</button>
      </div>
      <p class="access-note dim">The code is verified in the cloud, so it works when the tenant opens their page on any phone — no app install needed.</p>`
    : `
      <p class="access-note">Give this tenant a code so they can check their own balance, cycle and payment history instead of asking you. ${hasPhone ? '' : 'Add their phone number first — the code is sent by WhatsApp.'}</p>
      <div class="access-btns">
        <button class="btn btn-primary btn-sm" id="daCreate" type="button">Create access code</button>
        <button class="btn btn-ghost btn-sm" id="daTest" type="button">Test their page</button>
      </div>`}`;

  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('daCreate', async () => {
    t.accessPin = randPin(); writePin(t.id, t.accessPin); syncToLocal(); renderDetail(t);
    try { await pushPin(t.id, t.accessPin); } catch (e) { toast('Code saved on this device but not synced to the cloud — check your connection.'); }
    await writeAudit({ tenantId: t.id, tenantName: t.name, unit: t.unit, kind: 'access', summary: `Created access code for ${t.name}${t.unit ? ' · ' + t.unit : ''}`, detail: 'A self-service login code was issued.' });
    toast(`Code ${t.accessPin} created for ${t.name}.`);
  });
  on('daRegen', async () => {
    t.accessPin = randPin(); writePin(t.id, t.accessPin); syncToLocal(); renderDetail(t);
    try { await pushPin(t.id, t.accessPin); } catch (e) { toast('Code saved on this device but not synced to the cloud — check your connection.'); }
    await writeAudit({ tenantId: t.id, tenantName: t.name, unit: t.unit, kind: 'access', summary: `New access code for ${t.name}${t.unit ? ' · ' + t.unit : ''}`, detail: 'The old code no longer works.' });
    toast('New code issued — the old one no longer works.');
  });
  on('daRevoke', async () => {
    const ok = await confirmDialog({
      title: 'Revoke access code?',
      body: `${t.name} will no longer be able to open their account page with a code.`,
      okLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    t.accessPin = null;
    writePin(t.id, null);
    syncToLocal();
    renderDetail(t);
    try { await pushPin(t.id, null); } catch (e) { toast('Revoked on this device but the cloud copy may still work — check your connection.'); }
    await writeAudit({ tenantId: t.id, tenantName: t.name, unit: t.unit, kind: 'access', summary: `Revoked access code for ${t.name}${t.unit ? ' · ' + t.unit : ''}`, detail: 'Their self-service login no longer works.' });
    toast('Access code revoked.');
  });
  on('daCopy', () => { copyText(t.accessPin); });
  on('daShare', () => shareAccessWa(t));
  on('daTest', () => { window.open(tenantLink(t.id, 'demo'), '_blank'); toast('Opening their page…'); });
}

function copyText(txt) {
  const done = () => toast('Code copied — paste it into WhatsApp.');
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Copy blocked — long-press the code instead.'); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done, fallback);
  } else fallback();
}

function shareAccessWa(t) {
  const phone = normalizePhone(t.phone);
  if (!phone) { toast(`${t.name} has no phone — add one in Edit details.`); return; }
  if (!t.accessPin) { toast('Create an access code first.'); return; }
  const link = tenantLink(t.id, 'share');
  const msg = `Habari ${(t.name.split(' ')[0] || '')}, you can now check your internet account — balance, cycles and payments — here: ${link}  Your access code is: ${t.accessPin}. Karibu!`;
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
}

// ---------------------------------------------------------------
// Sheets plumbing
// ---------------------------------------------------------------
const BACKDROP = $('sheetBackdrop');
function openSheet(id) {
  document.querySelectorAll('.sheet.is-open').forEach(s => s.classList.remove('is-open'));
  BACKDROP.classList.add('is-open');
  const sheet = $(id);
  sheet.classList.add('is-open');
  sheet.scrollTop = 0;
}
function closeSheets() {
  BACKDROP.classList.remove('is-open');
  document.querySelectorAll('.sheet.is-open').forEach(s => s.classList.remove('is-open'));
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}

function confirmDialog({ title, body, okLabel = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const modal = $('modal');
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = body;
    const ok = $('modalOk');
    ok.textContent = okLabel;
    ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    modal.classList.add('is-open');
    modal._resolve = resolve;
  });
}
function settleModal(result) {
  const modal = $('modal');
  modal.classList.remove('is-open');
  if (modal._resolve) { modal._resolve(result); modal._resolve = null; }
}

// ---------------------------------------------------------------
// Add tenant
// ---------------------------------------------------------------
function openAddSheet() {
  const form = $('addTenantForm');
  form.reset();
  form.started.value = todayStr();
  form.payDate.value = todayStr();
  document.querySelector('#addTenantForm input[name="package"]').checked = true;
  openSheet('addTenantSheet');
}

async function handleAdd(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const pkg = PACKAGES[fd.get('package')] || pkgOf(fd.get('package'));
  const name = String(fd.get('name') || '').trim();
  if (!name) return;
  const started = fd.get('started') || todayStr();
  let startMs = dayMs(started) > dayMs(todayStr()) ? todayStr() : started;
  // Restart guard — a back-dated start bills EVERY cycle since that day as
  // unpaid, on top of any "owed before start". When a tenant was just removed
  // and is being re-added to start fresh, that silently rebuilds the old debt.
  // Ask once before committing to a back-dated start.
  if (dayMs(started) < dayMs(todayStr())) {
    const days = Math.max(1, pkg ? (pkg.days || 1) : 1);
    const cycles = 1 + Math.floor((dayMs(todayStr()) - dayMs(started)) / DAY_MS / days);
    const fromToday = await confirmDialog({
      title: 'Start from today instead?',
      body: `You picked <b>${escapeHtml(fmtDate(started))}</b> as the start. That bills every ${pkg ? escapeHtml(pkg.label.toLowerCase()) + ' cycle' : 'cycle'} since then — about <b>${cycles} cycle${cycles === 1 ? '' : 's'}</b> — as unpaid, on top of what you entered under “Owed before start”. If you're starting fresh, keep today's date and carry their old amount under “Owed before start”.`,
      okLabel: 'Start from today',
    });
    if (fromToday) startMs = todayStr();
  }
  const arrears = Math.max(0, Math.round(Number(fd.get('arrears')) || 0));
  const payAmount = Math.max(0, Math.round(Number(fd.get('payAmount')) || 0));
  const payMethod = fd.get('payMethod') === 'cash' ? 'cash' : 'mpesa';
  const payRef = payMethod === 'cash' ? '' : String(fd.get('payRef') || '').trim();
  const payDate = fd.get('payDate') || todayStr();

  const tenant = {
    id: uid(),
    name,
    unit: String(fd.get('unit') || '').trim(),
    phone: String(fd.get('phone') || '').trim(),
    openedOn: startMs,
    openingArrears: arrears,
    segments: [{ id: uid(), package: pkg.key, start: startMs, end: null, price: pkg.price, days: pkg.days }],
    payments: [],
    accessPin: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (payAmount > 0) {
    tenant.payments.push({ id: uid(), date: payDate, amount: payAmount, ref: payRef, method: payMethod, note: 'Joining payment', recorded_by: auditOperatorName() });
  }
  await DB.insert(tenant);
  tenants.push(tenant);
  syncToLocal();
  await writeAudit({
    tenantId: tenant.id, tenantName: tenant.name, unit: tenant.unit, kind: 'add',
    summary: `Added ${tenant.name}${tenant.unit ? ' · ' + tenant.unit : ''}`,
    detail: `${pkg.label} · ${money(pkg.price)}/cycle${payAmount > 0 ? ' · ' + money(payAmount) + ' received (' + (payMethod === 'cash' ? 'cash' : 'M-Pesa') + ')' : ''}`,
  });
  form.reset();
  closeSheets();
  renderAll();
  toast(`${tenant.name} (${tenant.unit || pkg.label}) is on the line.`);
}

// ---------------------------------------------------------------
// Record payment
// ---------------------------------------------------------------
let payContextTenantId = null;
let editPaymentId = null; // when set, the pay sheet edits this payment

function openPaymentSheet(id, suggestedAmount) {
  const t = tenants.find(x => x.id === id);
  if (!t) return;
  payContextTenantId = id;
  editPaymentId = null;
  const a = analyze(t);
  $('payContext').textContent = suggestedAmount != null
    ? `Recording the exact amount owed by ${t.name}.`
    : a.state === 'owed'
      ? `${t.name} owes ${money(a.owed)} — ${a.owedNote || 'outstanding'}.`
      : a.state === 'credit'
        ? `${t.name} is ${money(a.credit)} ahead — this tops up their credit.`
        : `${t.name} is settled — anything paid now goes to their credit (covers future cycles).`;
  $('payTitle').textContent = 'Record payment';
  $('payForm').querySelector('button[type="submit"]').textContent = 'Save payment';
  const form = $('payForm');
  form.reset();
  form.amount.value = suggestedAmount != null ? suggestedAmount : (a.owed > 0 ? a.owed : '');
  form.payDate.value = todayStr();
  $('payRefField').hidden = false;
  openSheet('paySheet');
  form.amount.focus();
}

// Reuse the pay sheet in edit mode — prefilled, updates the same row.
function openEditPayment(tenantId, paymentId) {
  const t = tenants.find(x => x.id === tenantId);
  const p = (t.payments || []).find(x => x.id === paymentId);
  if (!t || !p) return;
  payContextTenantId = tenantId;
  editPaymentId = paymentId;
  $('payTitle').textContent = 'Edit payment';
  $('payContext').textContent = `Fixing the ${money(p.amount)} payment on ${fmtDate(p.date, true)} for ${t.name}. The balance recalculates after saving.`;
  $('payForm').querySelector('button[type="submit"]').textContent = 'Save changes';
  const form = $('payForm');
  form.reset();
  form.amount.value = p.amount;
  form.payDate.value = p.date;
  const isCash = p.method === 'cash';
  const radio = form.querySelector(`input[name="method"][value="${isCash ? 'cash' : 'mpesa'}"]`);
  if (radio) radio.checked = true;
  $('payRefField').hidden = isCash;
  if (isCash) form.ref.value = '';
  else form.ref.value = p.ref || '';
  form.note.value = p.note || '';
  openSheet('paySheet');
  form.amount.focus();
}

async function handlePay(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const amount = Math.round(Number(fd.get('amount')) || 0);
  if (amount <= 0) { toast('Enter an amount first.'); return; }
  const t = tenants.find(x => x.id === payContextTenantId);
  if (!t) return;
  const method = fd.get('method') === 'cash' ? 'cash' : 'mpesa';
  const ref = method === 'cash' ? '' : String(fd.get('ref') || '').trim();
  const date = fd.get('payDate') || todayStr();
  const note = String(fd.get('note') || '').trim();

  if (editPaymentId) {
    const p = (t.payments || []).find(x => x.id === editPaymentId);
    editPaymentId = null;
    if (!p) { toast('That payment is no longer there.'); return; }
    const before = { amount: p.amount, date: p.date, method: p.method, ref: p.ref };
    p.amount = amount;
    p.date = date;
    p.method = method;
    p.ref = ref;
    p.note = note;
    await persistTenant(t);
    await writeAudit({
      tenantId: t.id, tenantName: t.name, unit: t.unit, kind: 'edit',
      summary: `Updated payment for ${t.name}${t.unit ? ' · ' + t.unit : ''}`,
      detail: `${money(before.amount)} on ${fmtDate(before.date, true)} (${before.method}) → ${money(amount)} on ${fmtDate(date, true)} (${method})${ref ? ' · ' + ref : ''}. Balance recalculated.`,
    });
    e.target.reset();
    closeSheets();
    renderAll();
    toast('Payment updated and balance recalculated.');
    return;
  }

  t.payments.push({
    id: uid(),
    date,
    amount,
    method,
    ref,
    note,
    recorded_by: auditOperatorName(),
  });
  await persistTenant(t);
  await writeAudit({
    tenantId: t.id, tenantName: t.name, unit: t.unit, kind: 'payment',
    summary: `${money(amount)} received from ${t.name}${t.unit ? ' · ' + t.unit : ''}`,
    detail: (method === 'cash' ? 'Cash' : 'M-Pesa' + (ref ? ' · ' + ref : '')) + ' on ' + fmtDate(date),
  });
  e.target.reset();
  closeSheets();
  renderAll();
  const a = analyze(t);
  toast(a.state === 'credit'
    ? `${money(amount)} saved for ${t.name} — now ${money(a.credit)} ahead.`
    : a.state === 'owed'
      ? `${money(amount)} saved — ${t.name} still owes ${money(a.owed)}.`
      : `${money(amount)} recorded for ${t.name}. All settled.`);
}

async function deletePayment(tenantId, paymentId) {
  const t = tenants.find(x => x.id === tenantId);
  if (!t) return;
  const p = (t.payments || []).find(x => x.id === paymentId);
  const ok = await confirmDialog({
    title: 'Delete payment?',
    body: `${p ? money(p.amount) + ' on ' + fmtDate(p.date) : 'This payment'} will be removed and the balance recalculated.`,
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  t.payments = (t.payments || []).filter(x => x.id !== paymentId);
  await persistTenant(t);
  await writeAudit({
    tenantId: t.id, tenantName: t.name, unit: t.unit, kind: 'edit',
    summary: `Deleted payment for ${t.name}${t.unit ? ' · ' + t.unit : ''}`,
    detail: `${p ? money(p.amount) + ' on ' + fmtDate(p.date) : 'a payment'} was removed and the balance recalculated.`,
  });
  renderAll();
  toast('Payment deleted and balance recalculated.');
}

// ---------------------------------------------------------------
// Mark away (pro-rates and closes the tenure)
// ---------------------------------------------------------------
function openAwaySheet(id) {
  const t = tenants.find(x => x.id === id);
  if (!t) return;
  payContextTenantId = id;
  const form = $('awayForm');
  form.reset();
  form.awayDate.value = todayStr();
  refreshAwayPreview();
  openSheet('awaySheet');
}

function refreshAwayPreview() {
  const t = tenants.find(x => x.id === payContextTenantId);
  if (!t) return;
  const form = $('awayForm');
  let date = form.awayDate.value || todayStr();
  const seg = activeSegment(t);
  if (seg && dayMs(date) < dayMs(seg.start)) { date = seg.start; form.awayDate.value = date; }
  if (dayMs(date) > dayMs(todayStr())) { date = todayStr(); form.awayDate.value = date; }

  const before = analyze(t);
  const after = simulateClose(t, date);
  const delta = after.totalBilled - before.totalBilled;
  const pkg = pkgOf(latestSeg(t).package);
  const D = pkg.days;
  const used = Math.floor((dayMs(date) - dayMs(latestSeg(t).start)) / DAY_MS);
  const inCycle = used % D;
  const cycleDays = used > 0 && inCycle === 0 ? 'used full cycles up to that date' : `used ${inCycle} of ${D} days of a ${pkg.label} cycle`;

  const parts = [];
  if (delta > 0) parts.push(`Closing bills an extra <b>${money(delta)}</b> for the half-finished cycle (${money(before.totalBilled)} was already billed).`);
  else if (delta < 0) parts.push(`<b>${money(-delta)}</b> of the current cycle is credited back — only the days actually used are billed.`);
  else parts.push(`Closing adds nothing to the ${money(before.totalBilled)} already billed.`);
  if (after.owed > 0) parts.push(`They will owe <b>${money(after.owed)}</b> after closing.`);
  else if (after.credit > 0) parts.push(`They will be <b>${money(after.credit)} ahead</b> — that credit stays for when they return.`);
  else parts.push('Their account will be exactly settled.');
  $('awayPreview').innerHTML = `
    <p class="preview-line">${escapeHtml(fmtDate(date))} — ${cycleDays}.</p>
    <p class="preview-line">${parts.join(' ')}</p>
    <p class="preview-line dim">Returning later starts a brand-new tenure from the arrival date. Nothing is billed while away.</p>`;
}

async function handleAway(e) {
  e.preventDefault();
  const t = tenants.find(x => x.id === payContextTenantId);
  if (!t) return;
  const seg = activeSegment(t);
  if (!seg) return;
  let date = $('awayForm').awayDate.value || todayStr();
  if (dayMs(date) < dayMs(seg.start)) date = seg.start;
  if (dayMs(date) > dayMs(todayStr())) date = todayStr();

  const before = analyze(t);
  const after = simulateClose(t, date);
  const delta = after.totalBilled - before.totalBilled;

  const ok = await confirmDialog({
    title: `Mark ${t.name} away?`,
    body: `Closing the tenure on <b>${escapeHtml(fmtDate(date))}</b> ${delta > 0 ? `bills <b>${money(delta)}</b> for the partial cycle` : delta < 0 ? `credits back <b>${money(-delta)}</b> for the unused part of the cycle` : 'adds nothing to what was already billed'}. ${
      after.owed > 0 ? `Balance after: <b>${money(after.owed)} owed</b>.` : after.credit > 0 ? `Balance after: <b>${money(after.credit)} prepaid credit</b>.` : 'Balance after: <b>settled</b>.'}`,
    okLabel: 'Mark away',
  });
  if (!ok) return;
  seg.end = date;
  await persistTenant(t);
  await writeAudit({
    tenantId: t.id, tenantName: t.name, unit: t.unit, kind: 'away',
    summary: `Marked ${t.name}${t.unit ? ' · ' + t.unit : ''} away`,
    detail: `Tenure closed on ${fmtDate(date)}${delta > 0 ? ' · ' + money(delta) + ' billed for the partial cycle' : ''}.`,
  });
  e.target.reset();
  closeSheets();
  renderAll();
  toast(`${t.name} marked away from ${fmtDate(date)}. ${delta > 0 ? money(delta) + ' billed for the partial cycle.' : ''}`);
}

// ---------------------------------------------------------------
// Bring back (starts a NEW tenure)
// ---------------------------------------------------------------
function openBackSheet(id) {
  const t = tenants.find(x => x.id === id);
  if (!t) return;
  payContextTenantId = id;
  const form = $('backForm');
  form.reset();
  form.backDate.value = todayStr();
  const prev = pkgOf(latestSeg(t).package);
  const radio = form.querySelector(`input[name="backPackage"][value="${prev.key}"]`);
  if (radio) radio.checked = true;
  refreshBackPreview();
  openSheet('backSheet');
}

function refreshBackPreview() {
  const t = tenants.find(x => x.id === payContextTenantId);
  if (!t) return;
  const form = $('backForm');
  let date = form.backDate.value || todayStr();
  if (dayMs(date) > dayMs(todayStr())) { date = todayStr(); form.backDate.value = date; }
  const awayEnd = latestSeg(t).end;
  if (awayEnd && dayMs(date) < dayMs(awayEnd)) { date = awayEnd; form.backDate.value = date; }

  const pkg = PACKAGES[form.querySelector('input[name="backPackage"]:checked')?.value] || pkgOf(latestSeg(t).package);
  const a = analyze(t);
  const pay = Math.max(0, Math.round(Number(form.payAmount.value) || 0));
  const after = a.balance + pkg.price - pay;
  const owedAfter = Math.max(0, after);
  const creditAfter = Math.max(0, -after);

  $('backPreview').innerHTML = `
    <p class="preview-line">New tenure starts <b>${escapeHtml(fmtDate(date))}</b> on <b>${pkg.label} · ${money(pkg.price)}</b> — a full cycle is billed from that day.</p>
    <p class="preview-line">${
      a.owed > 0 ? `They still owe <b>${money(a.owed)}</b> from before. ` :
      a.credit > 0 ? `They carry <b>${money(a.credit)} credit</b> which eats the new cycle first. ` : ''}${
      pay > 0 ? `You're recording <b>${money(pay)}</b> now. ` : ''}
      ${owedAfter > 0 ? `Balance after: <b>${money(owedAfter)} owed</b>.` : creditAfter > 0 ? `Balance after: <b>${money(creditAfter)} ahead</b>.` : 'Balance after: <b>settled</b>.'}</p>`;
}

async function handleBack(e) {
  e.preventDefault();
  const t = tenants.find(x => x.id === payContextTenantId);
  if (!t) return;
  const form = e.target;
  const fd = new FormData(form);
  const pkg = PACKAGES[fd.get('backPackage')] || pkgOf(latestSeg(t).package);
  let date = fd.get('backDate') || todayStr();
  if (dayMs(date) > dayMs(todayStr())) date = todayStr();
  const awayEnd = latestSeg(t).end;
  if (awayEnd && dayMs(date) < dayMs(awayEnd)) date = awayEnd;

  // Close any still-open segment so we never bill two active tenures at once.
  const openSeg = activeSegment(t);
  if (openSeg) {
    openSeg.end = date;
  }

  t.segments.push({ id: uid(), package: pkg.key, start: date, end: null, price: pkg.price, days: pkg.days });
  const payAmount = Math.max(0, Math.round(Number(fd.get('payAmount')) || 0));
  const payMethod = fd.get('payMethod') === 'cash' ? 'cash' : 'mpesa';
  if (payAmount > 0) {
    t.payments.push({
      id: uid(), date: fd.get('payDate') || todayStr(), amount: payAmount,
      method: payMethod,
      ref: payMethod === 'cash' ? '' : String(fd.get('payRef') || '').trim(), note: 'Returning payment',
      recorded_by: auditOperatorName(),
    });
  }
  await persistTenant(t);
  await writeAudit({
    tenantId: t.id, tenantName: t.name, unit: t.unit, kind: 'back',
    summary: `Brought ${t.name}${t.unit ? ' · ' + t.unit : ''} back`,
    detail: `New tenure from ${fmtDate(date)} on ${pkg.label} · ${money(pkg.price)}${payAmount > 0 ? ' · ' + money(payAmount) + ' received (' + (payMethod === 'cash' ? 'cash' : 'M-Pesa') + ')' : ''}.`,
  });
  form.reset();
  closeSheets();
  renderAll();
  const a = analyze(t);
  toast(a.owed > 0 ? `${t.name} is back on ${pkg.label} — ${money(a.owed)} still owed.` : `${t.name} is back on ${pkg.label}.`);
}

// ---------------------------------------------------------------
// Change package — switch an active tenant without re-billing history
// ---------------------------------------------------------------
// The current cycle is left to finish on the old price (its full
// cycles already billed keep their amount) and the new package starts
// the tenant's next renewal day, in a fresh open segment.
function nextCycleStart(t) {
  const seg = activeSegment(t);
  if (!seg) return null;
  const pkg = pkgOf(seg.package);
  const { days } = segPriceDays(seg, pkg);
  const elapsed = Math.floor((dayMs(todayStr()) - dayMs(seg.start)) / DAY_MS);
  const started = Math.floor(elapsed / days) + 1;
  return addDays(seg.start, started * days);
}

function openChangeSheet(id) {
  const t = tenants.find(x => x.id === id);
  if (!t || isAway(t)) return;
  payContextTenantId = id;
  const form = $('changeForm');
  form.reset();
  const cur = pkgOf(activeSegment(t).package);
  const radio = form.querySelector(`input[name="changePackage"][value="${cur.key}"]`);
  if (radio) radio.checked = true;
  refreshChangePreview();
  openSheet('changeSheet');
}

function refreshChangePreview() {
  const t = tenants.find(x => x.id === payContextTenantId);
  if (!t) return;
  const seg = activeSegment(t);
  if (!seg) return;
  const form = $('changeForm');
  const cur = pkgOf(seg.package);
  const nxt = PACKAGES[form.querySelector('input[name="changePackage"]:checked')?.value] || cur;
  const start = nextCycleStart(t);
  $('changePreview').innerHTML = nxt.key === cur.key
    ? `<p class="preview-line">Already on <b>${cur.label} · ${money(cur.price)}</b> — pick a different package to switch.</p>`
    : `<p class="preview-line">Current <b>${cur.label} · ${money(cur.price)}</b> runs until <b>${fmtDate(start, true)}</b> — today's cycle is not split or pro-rated.</p>
       <p class="preview-line">From <b>${fmtDate(start, true)}</b> they move to <b>${nxt.label} · ${money(nxt.price)}</b>, first charge landing on that day.</p>
       <p class="preview-line">Outstanding balances, credit and payment history carry over untouched.</p>`;
}

async function handleChange(e) {
  e.preventDefault();
  const t = tenants.find(x => x.id === payContextTenantId);
  if (!t) return;
  const seg = activeSegment(t);
  if (!seg) return;
  const fd = new FormData(e.target);
  const cur = pkgOf(seg.package);
  const nxt = PACKAGES[fd.get('changePackage')] || cur;
  if (nxt.key === cur.key) { toast(`${t.name} is already on ${cur.label} · ${money(cur.price)}.`); return; }
  const start = nextCycleStart(t);
  const bound = fmtDate(start, true);
  seg.end = start;
  t.segments.push({ id: uid(), package: nxt.key, start, end: null, price: nxt.price, days: nxt.days });
  await persistTenant(t);
  await writeAudit({
    tenantId: t.id, tenantName: t.name, unit: t.unit, kind: 'package',
    summary: `Changed ${t.name}${t.unit ? ' · ' + t.unit : ''} to ${nxt.label} · ${money(nxt.price)}`,
    detail: `Moved from ${cur.label} · ${money(cur.price)} to ${nxt.label} · ${money(nxt.price)} from ${bound}. Balance recalculated.`,
  });
  e.target.reset();
  closeSheets();
  renderAll();
  toast(`${t.name} moves to ${nxt.label} · ${money(nxt.price)} from ${bound}.`);
}

// ---------------------------------------------------------------
// Edit / delete tenant
// ---------------------------------------------------------------
function openEditSheet(id) {
  const t = tenants.find(x => x.id === id);
  if (!t) return;
  payContextTenantId = id;
  const form = $('editForm');
  form.name.value = t.name;
  form.unit.value = t.unit || '';
  form.phone.value = t.phone || '';
  form.firstStart.value = t.segments[0] ? t.segments[0].start : t.openedOn;
  form.arrears.value = t.openingArrears || 0;
  const cur = analyze(t);
  form.setBalance.placeholder = `current ${money(cur.balance)}`;
  openSheet('editSheet');
}

async function handleEdit(e) {
  e.preventDefault();
  const t = tenants.find(x => x.id === payContextTenantId);
  if (!t) return;
  const fd = new FormData(e.target);
  const setBalance = Number(fd.get('setBalance')) || null;
  const patch = {
    name: String(fd.get('name') || '').trim(),
    unit: String(fd.get('unit') || '').trim(),
    phone: String(fd.get('phone') || '').trim(),
    openingArrears: Math.max(0, Math.round(Number(fd.get('arrears')) || 0)),
  };
  if (setBalance !== null) {
    const cur = analyze(t);
    const diff = setBalance - cur.balance;
    if (diff > 0) {
      patch.openingArrears = Math.max(0, Math.round(t.openingArrears + diff));
    } else if (diff < 0) {
      const adj = Math.round(-diff);
      t.payments.push({
        id: uid(),
        date: todayStr(),
        amount: adj,
        method: 'cash',
        ref: null,
        note: `Balance adjustment to ${money(setBalance)}`,
        recorded_by: auditOperatorName(),
      });
    }
  }
  const newStart = fd.get('firstStart') || t.segments[0].start;
  if (t.segments[0] && newStart !== t.segments[0].start) {
    const ok = await confirmDialog({
      title: 'Move the start date?',
      body: `Changing the original start date to <b>${escapeHtml(fmtDate(newStart))}</b> re-bills every cycle from that day. Payments are not changed.`,
      okLabel: 'Move it',
    });
    if (!ok) return;
    t.segments[0].start = newStart;
  }

  // Guard: never save with two open (end_date null) segments — close all but
  // the most recently started one so balances can't double-bill.
  const opens = t.segments.filter(s => !s.end).sort((a, b) => dayMs(a.start) - dayMs(b.start));
  for (let i = 0; i < opens.length - 1; i++) {
    opens[i].end = opens[opens.length - 1].start;
  }

  Object.assign(t, patch);
  await persistTenant(t);
  await writeAudit({
    tenantId: t.id, tenantName: t.name, unit: t.unit, kind: 'edit',
    summary: `Edited ${t.name}${t.unit ? ' · ' + t.unit : ''}`,
    detail: 'Details updated and balance recalculated.',
  });
  e.target.reset();
  closeSheets();
  renderAll();
  toast('Details saved and balance recalculated.');
}

async function handleDeleteTenant() {
  const t = tenants.find(x => x.id === payContextTenantId);
  if (!t) return;
  const ok = await confirmDialog({
    title: `Remove ${t.name}?`,
    body: `Their whole ledger — billed cycles and payment history — will be deleted. This cannot be undone.`,
    okLabel: 'Remove tenant',
    danger: true,
  });
  if (!ok) return;
  try {
    await DB.remove(t.id);
  } catch (err) {
    toast(err && err.message ? err.message : 'Could not remove the tenant.');
    return;
  }
  // Cloud row (and its segments/payments/thread) is gone — now clear this
  // device's sidecars: access code, chat thread and presence.
  purgeTenantLocals(t.id);
  tenants = tenants.filter(x => x.id !== t.id);
  syncToLocal();
  // Logged AFTER the delete, with no tenant_id (the row is gone) but the
  // name kept, so the Audit tab still shows that they were removed.
  await writeAudit({
    tenantId: null, tenantName: t.name, unit: t.unit, kind: 'remove',
    summary: `Removed ${t.name}${t.unit ? ' · ' + t.unit : ''} from the ledger`,
    detail: 'Their whole ledger — billed cycles and payment history — was deleted.',
  });
  detailId = null;
  closeSheets();
  renderAll();
  toast(`${t.name} removed from the line.`);
}

// ---------------------------------------------------------------
// WhatsApp reminders (owner → tenant)
// ---------------------------------------------------------------
function sendWhatsApp(id) {
  const t = tenants.find(x => x.id === id);
  if (!t) return;
  const phone = normalizePhone(t.phone);
  const first = (t.name.split(' ')[0] || '');
  const pkg = pkgOf(latestSeg(t).package);
  const a = analyze(t);
  const place = `${t.unit ? t.unit + ', ' : ''}${pkg.label}`;
  let msg;
  if (isAway(t)) {
    msg = a.owed > 0
      ? `Habari ${first}, karibu tena! Your ${place} internet is ready to resume. There's ${money(a.owed)} outstanding — let me know when you're back so we sort it out. Asante!`
      : `Habari ${first}, when you're back your ${place} internet can resume any day — let me know and I'll switch you on.`;
  } else if (a.state === 'owed') {
    msg = `Habari ${first}, your ${place} internet has ${money(a.owed)} remaining to pay. Kindly top up so the line stays on. Asante!`;
  } else {
    msg = `Habari ${first}, your ${place} internet is fully paid up. Asante sana!`;
  }
  if (!phone) {
    toast(`${t.name} has no phone saved — edit their details to add one.`);
    return;
  }
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
}

// ---------------------------------------------------------------
// Inbox — tenant messages, presence, notifications (local mock)
// ---------------------------------------------------------------
const OWNER_QUICK = [
  'Noted — asante 🙏',
  'I will check and come to you',
  'Kindly resend the M-Pesa code',
  'Updated your record ✅',
];
let activeThreadId = null;
let knownUnread = {};
let inboxBooted = false;

function tenantName(id) { const t = tenants.find(x => x.id === id); return t ? t.name : 'Tenant'; }
function unreadTotal() { return loadMessages().filter(m => m.from === 'tenant' && !m.read && !threadDeletedFor(m.tenantId, 'owner')).length; }
function tenantLastSeen(id) { const p = loadPresence(); return (p.tenants || {})[id]; }

function badgeInbox() {
  const n = unreadTotal();
  const b = $('inboxBadge');
  if (b) { b.textContent = n; b.hidden = n === 0; }
  updateNotifState();
}

function updateNotifState() {
  const st = $('notifState');
  const btn = $('notifBtn');
  if (!st || !btn) return;
  if (typeof Notification === 'undefined') { st.textContent = 'pop-ups not supported'; st.className = 'pill pill-away'; btn.hidden = true; return; }
  const perm = Notification.permission;
  if (perm === 'granted') { st.textContent = 'pop-ups on'; st.className = 'pill pill-active'; btn.hidden = true; }
  else if (perm === 'denied') { st.textContent = 'blocked by browser'; st.className = 'pill pill-away'; btn.hidden = true; }
  else { st.textContent = 'pop-ups off'; st.className = 'pill pill-away'; btn.hidden = false; }
}

function inboxPulse() {
  const msgs = loadMessages();
  const unread = msgs.filter(m => m.from === 'tenant' && !m.read && !threadDeletedFor(m.tenantId, 'owner'));
  let arrived = unread.filter(m => !knownUnread[m.id]);
  if (!inboxBooted) { inboxBooted = true; arrived = []; } // no pop-ups for pre-existing backlog
  unread.forEach(m => { knownUnread[m.id] = 1; });
  Object.keys(knownUnread).forEach(id => { if (!unread.some(m => m.id === id)) delete knownUnread[id]; });
  badgeInbox();
  if (view === 'inbox') renderInbox();
  if (arrived.length) {
    if (activeThreadId && activeThreadId === arrived[0].tenantId) renderThread();
    const first = arrived[0];
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'hidden') {
      try { new Notification('Faiba — ' + tenantName(first.tenantId), { body: first.text }); } catch (e) { /* pop-up blocked — badge still shows */ }
    }
  }
}

function touchOwner() {
  const p = loadPresence();
  p.owner = Date.now();
  savePresence(p);
}

function renderInbox() {
  const list = $('inboxList');
  const msgs = loadMessages();
  const byTenant = {};
  msgs.forEach(m => {
    if (threadDeletedFor(m.tenantId, 'owner')) return; // deleted on my side — hidden until they write again
    (byTenant[m.tenantId] = byTenant[m.tenantId] || []).push(m);
  });
  const rows = Object.keys(byTenant).map(id => {
    const arr = byTenant[id].sort((a, b) => a.ts - b.ts);
    const last = arr[arr.length - 1];
    const unread = arr.filter(m => m.from === 'tenant' && !m.read).length;
    return { id, last, unread, lastTs: last.ts };
  }).sort((a, b) => (b.unread > 0) - (a.unread > 0) || b.lastTs - a.lastTs);
  if (!rows.length) { list.innerHTML = '<p class="dim-empty">No conversations here yet. When a tenant writes on their page, it lands here with a badge — and a pop-up if you allow it.</p>'; return; }

  list.innerHTML = rows.map((r, i) => {
    const who = tenants.find(x => x.id === r.id);
    const lastSeen = tenantLastSeen(r.id);
    const snippet = r.last.text.length > 62 ? r.last.text.slice(0, 62) + '…' : r.last.text;
    return `
    <div class="crow inbox-row ${r.unread ? 'is-unread' : ''}" data-thread="${r.id}" style="animation-delay:${Math.min(i, 12) * 30}ms">
      <div class="crow-main">
        <div class="crow-head">
          <span class="crow-name">${escapeHtml(who ? who.name : '(removed tenant)')}</span>
          ${who && who.unit ? `<span class="crow-unit">${escapeHtml(who.unit)}</span>` : ''}
          ${r.unread ? `<span class="pill pill-partial">${r.unread} new</span>` : ''}
        </div>
        <div class="crow-sub">${escapeHtml(snippet)}</div>
      </div>
      <div class="crow-owed">
        <span class="crow-amt is-ago">${escapeHtml(fmtAgo(r.lastTs))}</span>
        <span class="crow-note">${who ? (isOnline(lastSeen) ? 'online now' : 'last seen ' + fmtAgo(lastSeen)) : ''}</span>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-thread]').forEach(el => el.addEventListener('click', () => openThreadSheet(el.dataset.thread)));
}

function threadBubble(m) {
  const side = m.from === 'tenant' ? 'is-tenant' : (m.from === 'auto' ? 'is-auto' : 'is-owner');
  const d = new Date(m.ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const label = sameDay ? time : `${fmtDate(m.ts, true)} · ${time}`;
  return `<div class="bubble ${side}"><span class="bubble-text">${escapeHtml(m.text)}</span><span class="bubble-time">${m.from === 'auto' ? '⚡ auto · ' : ''}${label}</span></div>`;
}

function sendOwnerMsg(text) {
  const t = tenants.find(x => x.id === activeThreadId);
  if (!t || !text.trim()) return;
  const all = loadMessages();
  all.push({ id: uid(), tenantId: t.id, ts: Date.now(), from: 'owner', kind: 'ack', read: true, text: text.trim() });
  saveMessages(all);
  noteNewMessage(t.id);
  renderThread();
}

function renderThread() {
  const t = tenants.find(x => x.id === activeThreadId);
  if (!t) return;
  const msgs = loadMessages().filter(m => m.tenantId === t.id).sort((a, b) => a.ts - b.ts);
  const a = analyze(t);
  const ls = tenantLastSeen(t.id);
  $('threadWho').innerHTML = `
    <span class="d-avatar ${isAway(t) ? 'away' : ''}">${escapeHtml(initials(t.name))}</span>
    <span class="t-id">
      <span class="t-name">${escapeHtml(t.name)}</span>
      <span class="t-sub">${escapeHtml(t.unit)} · ${pkgOf(latestSeg(t).package).label}</span>
      <span class="t-phone">${isOnline(ls) ? '<span class="dot green"></span> online now' : 'last seen ' + fmtAgo(ls)}${a.owed > 0 ? ' · owes ' + money(a.owed) : ''}</span>
    </span>`;
  $('threadMsgs').innerHTML = msgs.length ? msgs.map(threadBubble).join('') : '<p class="chat-empty">Nothing here yet — say something below.</p>';
  const box = $('threadMsgs');
  box.scrollTop = box.scrollHeight;
  $('ownerChips').innerHTML = OWNER_QUICK.map((c, i) => `<button class="chip" data-ack="${i}" type="button">${escapeHtml(c)}</button>`).join('');
  $('ownerChips').querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', () => sendOwnerMsg(OWNER_QUICK[Number(b.dataset.ack)])));
  const inp = $('ownerComposeInput');
  inp.value = '';
  inp.focus();
  $('ownerComposeSend').onclick = () => { sendOwnerMsg(inp.value); inp.value = ''; };
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendOwnerMsg(inp.value); inp.value = ''; } };
  $('threadDel').onclick = handleDeleteThread;
  $('threadWa').onclick = () => continueOnWhatsApp(t);
  markThreadRead(t.id);
}

function markThreadRead(id) {
  const msgs = loadMessages();
  let changed = false;
  msgs.forEach(m => { if (m.tenantId === id && m.from === 'tenant' && !m.read) { m.read = true; changed = true; } });
  if (!changed) return;
  saveMessages(msgs);
  Object.keys(knownUnread).forEach(k => { const m = msgs.find(x => x.id === k); if (m && m.read) delete knownUnread[k]; });
  badgeInbox();
  if (view === 'inbox') renderInbox();
  if (detailId === id) renderDetail(tenants.find(x => x.id === id));
}

function openThreadSheet(id) {
  activeThreadId = id;
  const t = tenants.find(x => x.id === id);
  if (!t) { toast('That tenant no longer exists.'); return; }
  renderThread();
  openSheet('threadSheet');
}

async function handleDeleteThread() {
  const t = tenants.find(x => x.id === activeThreadId);
  if (!t) return;
  const ok = await confirmDialog({
    title: 'Delete this conversation?',
    body: `It's removed from <b>your</b> inbox only — <b>${escapeHtml(t.name)}</b> keeps their own copy of the messages. If they write again, the thread comes back.`,
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  deleteThreadFor(t.id, 'owner');
  closeSheets();
  activeThreadId = null;
  badgeInbox();
  if (view === 'inbox') renderInbox();
  toast('Conversation deleted from your side.');
}

function continueOnWhatsApp(t) {
  const phone = normalizePhone(t.phone);
  if (!phone) { toast(`${t.name} has no phone saved — add one in Edit details.`); return; }
  const all = loadMessages().filter(m => m.tenantId === t.id);
  const last = all[all.length - 1];
  const msg = `Habari ${(t.name.split(' ')[0] || '')}, I saw your message on Faiba Ledger${last ? ` ("${last.text.slice(0, 90)}")` : ''} — let's sort it out.`;
  window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(msg), '_blank');
}

// ---------------------------------------------------------------
// Settings
// ---------------------------------------------------------------
function openSettingsSheet() {
  $('settingsForm').ownerPhone.value = getOwnerPhone();
  syncInstallRow();
  openSheet('settingsSheet');
}

// The install row in Settings, kept in step with pwa.js: a plain
// install button normally, an "Installed" tag once the app is running
// from the home screen.
function syncInstallRow() {
  const btn = $('installAppBtn');
  if (!btn || !window.FaibaPWA) return;
  const installed = FaibaPWA.isStandalone();
  $('pwaInstallTag').hidden = !installed;
  btn.hidden = installed;
  if (!installed) btn.textContent = FaibaPWA.isIOS() ? 'Show me how' : 'Install the app';
}
function handleSettings(e) {
  e.preventDefault();
  setOwnerPhone(new FormData(e.target).get('ownerPhone'));
  closeSheets();
  toast('Settings saved.');
}

// One-time lift: push the demo data still sitting on this device's
// localStorage (from before the cloud wiring) up into Supabase.
// Idempotent — tenants already in the cloud are skipped, nothing
// locally is deleted.
async function handleUploadCloud() {
  const local = loadTenantList();
  if (!local.length) {
    toast('Nothing to upload — this device has no saved demo data.');
    return;
  }
  let cloud = [];
  try { cloud = await DB.getAll(); } catch (e) { toast('Could not read the cloud — check your connection.'); return; }
  const cloudIds = new Set(cloud.map(t => t.id));
  const fresh = local.filter(t => !cloudIds.has(t.id));
  if (!fresh.length) { toast('Everything on this device is already in the cloud.'); return; }
  const ok = await confirmDialog({
    title: `Upload ${fresh.length} tenant${fresh.length === 1 ? '' : 's'}?`,
    body: `This device has <b>${fresh.length}</b> tenant${fresh.length === 1 ? '' : 's'} with ${fresh.length === 1 ? 'their full ledger' : 'full ledgers'} (cycles, payments, arrears) that aren't in the cloud yet. They'll be added to your online ledger — nothing is deleted from this device.`,
    okLabel: 'Upload',
  });
  if (!ok) return;
  try {
    for (const t of fresh) await DB.insert(t);
    tenants = await DB.getAll();
    syncToLocal();
    renderAll();
    closeSheets();
    setTimeout(() => { syncLocalPinsToCloud().catch(() => {}); }, 0);
    toast(`${fresh.length} tenant${fresh.length === 1 ? '' : 's'} uploaded to the cloud.`);
  } catch (err) {
    toast('Upload failed: ' + (err && err.message ? err.message : String(err)));
  }
}

// ---------------------------------------------------------------
// Team — operators who run the ledger with the owner
// ---------------------------------------------------------------
async function renderTeam() {
  const box = $('teamList');
  const addForm = $('addOpForm');
  const isOwner = CURRENT_OPERATOR && CURRENT_OPERATOR.role === 'owner';
  addForm.hidden = !isOwner;
  $('teamOwnerNote').hidden = isOwner;
  let rows = [];
  try {
    const { data, error } = await supabaseClient.from('operators').select('id, role, name, created_at');
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    box.innerHTML = `<p class="dim-empty">Could not load the team: ${escapeHtml(e.message || e)}</p>`;
    return;
  }
  rows.sort((a, b) => (a.role === b.role ? 0 : a.role === 'owner' ? -1 : 1));
  box.innerHTML = rows.length
    ? rows.map(r => {
        const self = CURRENT_OPERATOR && r.id === CURRENT_OPERATOR.id;
        const avatarText = escapeHtml(initials(r.name || (r.id || '?').slice(0, 8)));
        return `
        <div class="team-row">
          <span class="team-avatar">${avatarText}</span>
          <div class="team-main">
            <span class="team-name">${escapeHtml(r.name || 'Unnamed operator')}${self ? ' <em>(you)</em>' : ''}</span>
            <span class="team-role">${r.role === 'owner' ? 'Owner' : 'Admin'}</span>
          </div>
          ${isOwner && r.role !== 'owner'
            ? `<button class="btn btn-danger-ghost btn-sm" data-rm-op="${r.id}" data-rm-name="${escapeHtml(r.name || 'this operator')}" type="button">Remove</button>`
            : ''}
        </div>`;
      }).join('')
    : '<p class="dim-empty">No operators yet — the first person to sign in becomes the owner.</p>';
  box.querySelectorAll('[data-rm-op]').forEach(b => b.addEventListener('click', () => handleRemoveOperator(b.dataset.rmOp, b.dataset.rmName)));
}

async function handleAddOperator(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const name = String(fd.get('opName') || '').trim();
  const email = String(fd.get('opEmail') || '').trim().toLowerCase();
  const password = String(fd.get('opPwd') || '');
  if (!email || password.length < 6) { toast('Enter a valid email and a password of at least 6 characters.'); return; }
  try {
    // Remember the owner's session in case signUp swaps it (only happens
    // when email confirmation is off in the project settings).
    const { data: { session } } = await supabaseClient.auth.getSession();
    const backup = session ? { access_token: session.access_token, refresh_token: session.refresh_token } : null;
    const res = await supabaseClient.auth.signUp({ email, password });
    if (res.error) throw res.error;
    if (!res.data.user) throw new Error('account_not_created');
    if (backup) await supabaseClient.auth.setSession(backup);
    const ins = await supabaseClient.from('operators').insert({
      id: res.data.user.id, role: 'admin', name: name || null,
    });
    if (ins.error) throw ins.error;
    e.target.reset();
    renderTeam();
    toast(`${name || email} added as admin. They'll get an activation email — tap the link once, then they can sign in with the password you set.`);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/account_not_created/.test(msg)) {
      toast('The account could not be created — check the email and try again.');
    } else if (/already registered|already been registered|already exists/i.test(msg)) {
      toast('That email already has an account (maybe from an earlier try). Ask them to open the login page and tap "Forgot password?" — the recovery link activates the account and lets them set their own password.');
    } else if (/is invalid/i.test(msg) && /email/i.test(msg)) {
      toast('That email was rejected — it must be a real address that can receive mail (e.g. name@gmail.com). Check for typos.');
    } else if (/signups? (are )?(not )?disabled|not allowed/i.test(msg)) {
      toast('New sign-ups are switched off on this project. In Supabase: Authentication → Sign In / Up → turn on "Allow new users to sign up", then try again.');
    } else {
      toast('Could not add: ' + msg);
    }
  }
}

async function handleRemoveOperator(id, name) {
  const ok = await confirmDialog({
    title: 'Remove this operator?',
    body: `<b>${escapeHtml(name)}</b> will no longer be able to open the ledger. (Their login account stays, but access stops immediately.)`,
    okLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    const { error } = await supabaseClient.from('operators').delete().eq('id', id);
    if (error) throw error;
    renderTeam();
    toast('Operator removed.');
  } catch (err) {
    toast('Could not remove: ' + (err && err.message ? err.message : String(err)));
  }
}

async function handleChangePassword(e) {
  e.preventDefault();
  const pwd = String(new FormData(e.target).get('newPwd') || '');
  if (pwd.length < 6) { toast('New password must be at least 6 characters.'); return; }
  try {
    const { error } = await supabaseClient.auth.updateUser({ password: pwd });
    if (error) throw error;
    e.target.reset();
    toast('Password updated — use it next time you sign in.');
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/reauthentication|re-auth|recently/i.test(msg)) {
      toast('Security: sign out and sign in again, then retry the change.');
    } else {
      toast('Could not change password: ' + msg);
    }
  }
}

// ---------------------------------------------------------------
// Icons
// ---------------------------------------------------------------
const ICONS = {
  wa: `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>`,
  x: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  op: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M5 21a7 7 0 0 1 14 0"/></svg>`,
};

// ---------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Packages — Settings list + add / edit / switch off
// ---------------------------------------------------------------
function pkgSlug(label) {
  return String(label || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'package';
}

async function renderPackages() {
  const box = $('pkgList');
  if (!box) return;
  let rows = [];
  try {
    rows = await DB.getPackages();
  } catch (e) {
    box.innerHTML = `<p class="dim-empty">Could not load packages: ${escapeHtml(e.message || e)}</p>`;
    return;
  }
  setPackages(rows);
  renderPackagePickers();
  if (!rows.length) {
    box.innerHTML = '<p class="dim-empty">No packages yet — add one below.</p>';
    return;
  }
  box.innerHTML = rows.map(p => `
    <div class="team-row">
      <div class="team-main">
        <span class="team-name">${escapeHtml(p.label)}${p.active ? '' : ' <em>(switched off)</em>'}</span>
        <span class="team-role">${money(p.price)} · ${p.days} day${p.days === 1 ? '' : 's'}</span>
      </div>
      <button class="btn btn-ghost btn-sm" data-edit-pkg="${escapeHtml(p.key)}" type="button">Edit</button>
      <button class="btn ${p.active ? 'btn-danger-ghost' : 'btn-primary'} btn-sm" data-toggle-pkg="${escapeHtml(p.key)}" data-active="${p.active ? '1' : '0'}" type="button">${p.active ? 'Switch off' : 'Switch on'}</button>
    </div>`).join('');
  box.querySelectorAll('[data-edit-pkg]').forEach(b => b.addEventListener('click', () => editPackage(b.dataset.editPkg)));
  box.querySelectorAll('[data-toggle-pkg]').forEach(b => b.addEventListener('click', () => togglePackage(b.dataset.togglePkg, b.dataset.active === '1')));
}

async function handleAddPackage(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const label = String(fd.get('pkgLabel') || '').trim();
  const price = Math.round(Number(fd.get('pkgPrice')) || 0);
  const days = Math.max(1, Math.round(Number(fd.get('pkgDays')) || 1));
  if (!label || price <= 0) { toast('Enter a name and a price greater than zero.'); return; }
  try {
    const base = pkgSlug(label);
    const existing = new Set((await DB.getPackages()).map(p => p.key));
    let key = base, i = 2;
    while (existing.has(key)) key = `${base}-${i++}`;
    await DB.addPackage({ key, label, price, days, sortOrder: 100 });
    e.target.reset();
    e.target.pkgDays.value = '7';
    await renderPackages();
    toast(`${label} · ${money(price)} added.`);
    await writeAudit({ tenantId: null, kind: 'other', summary: `Added package ${label} · ${money(price)}`, detail: `${days}-day cycle.` });
  } catch (err) {
    toast('Could not add the package: ' + (err && err.message ? err.message : String(err)));
  }
}

async function togglePackage(key, isActive) {
  try {
    await DB.updatePackage(key, { active: !isActive });
    await renderPackages();
    toast(isActive ? 'Package switched off — new sign-ups won\'t see it.' : 'Package switched back on.');
  } catch (err) {
    toast('Could not update the package: ' + (err && err.message ? err.message : String(err)));
  }
}

async function editPackage(key) {
  const current = PACKAGES[key];
  if (!current) return;
  const label = window.prompt('Package name:', current.label);
  if (label === null) return;
  const priceStr = window.prompt('Price (KSh):', String(current.price));
  if (priceStr === null) return;
  const daysStr = window.prompt('Cycle length (days):', String(current.days));
  if (daysStr === null) return;
  const price = Math.round(Number(priceStr) || 0);
  const days = Math.max(1, Math.round(Number(daysStr) || 1));
  if (!String(label).trim() || price <= 0) { toast('A name and a price above zero are required.'); return; }
  try {
    await DB.updatePackage(key, { label: String(label).trim(), price, days });
    await renderPackages();
    toast('Package updated. New cycles use the new price; already-billed ones are untouched.');
    await writeAudit({ tenantId: null, kind: 'other', summary: `Edited package ${String(label).trim()} · ${money(price)}`, detail: `${days}-day cycle.` });
  } catch (err) {
    toast('Could not update the package: ' + (err && err.message ? err.message : String(err)));
  }
}

function wireEvents() {
  document.querySelectorAll('.nav-tab').forEach(btn => btn.addEventListener('click', () => {
    view = btn.dataset.tab;
    closeSheets();
    detailId = null;
    renderAll();
    window.scrollTo(0, 0);
  }));

  $('addTopBtn').addEventListener('click', openAddSheet);
  $('addEmptyBtn').addEventListener('click', openAddSheet);
  $('addTenantForm').addEventListener('submit', handleAdd);

  $('tenantSearch').addEventListener('input', e => { search = e.target.value; renderTenantList(); });
  $('chipRow').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    filter = chip.dataset.f;
    renderTenantList();
  });

  $('reportChips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    reportMode = chip.dataset.rm;
    renderReport();
  });

  $('auditFilterAll').addEventListener('click', () => {
    auditFilter = 'all';
    $('auditFilterAll').classList.add('is-active');
    $('auditFilterTenant').classList.remove('is-active');
    renderAudit();
  });
  $('auditFilterTenant').addEventListener('click', () => {
    auditFilter = 'tenant';
    $('auditFilterTenant').classList.add('is-active');
    $('auditFilterAll').classList.remove('is-active');
    renderAudit();
  });

  BACKDROP.addEventListener('click', closeSheets);
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheets(); settleModal(false); } });

  $('payForm').addEventListener('submit', handlePay);

  // Payment method toggles (M-Pesa shows the code field, cash hides it)
  const bindPayMethods = (specs) => {
    specs.forEach(({ groupId, refFieldId, name }) => {
      const group = document.getElementById(groupId);
      const refField = document.getElementById(refFieldId);
      if (!group) return;
      group.querySelectorAll('input[name="' + name + '"]').forEach(r => r.addEventListener('change', () => {
        const isCash = group.querySelector('input[name="' + name + '"]:checked')?.value === 'cash';
        if (refField) refField.hidden = isCash;
        if (isCash && refField) { const inp = refField.querySelector('input'); if (inp) inp.value = ''; }
      }));
    });
  };
  bindPayMethods([
    { groupId: 'payMethod', refFieldId: 'payRefField', name: 'method' },
    { groupId: 'addPayMethod', refFieldId: 'addPayRefField', name: 'payMethod' },
    { groupId: 'backPayMethod', refFieldId: 'backPayRefField', name: 'payMethod' },
  ]);

  $('awayForm').addEventListener('submit', handleAway);
  $('awayForm').awayDate.addEventListener('change', refreshAwayPreview);
  $('backForm').addEventListener('submit', handleBack);
  $('backForm').backDate.addEventListener('change', refreshBackPreview);
  $('backForm').payAmount.addEventListener('input', refreshBackPreview);
  // Delegated: the radio options are re-rendered whenever the catalogue
  // loads, so per-input listeners would be thrown away.
  $('backForm').addEventListener('change', e => { if (e.target.name === 'backPackage') refreshBackPreview(); });
  $('changeForm').addEventListener('submit', handleChange);
  $('changeForm').addEventListener('change', e => { if (e.target.name === 'changePackage') refreshChangePreview(); });

  $('editBtn').addEventListener('click', () => { if (detailId) openEditSheet(detailId); });
  $('editForm').addEventListener('submit', handleEdit);
  $('deleteBtn').addEventListener('click', handleDeleteTenant);

  $('modalCancel').addEventListener('click', () => settleModal(false));
  $('modalOk').addEventListener('click', () => settleModal(true));
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) settleModal(false); });

  $('settingsBtn').addEventListener('click', () => { renderTeam(); renderPackages(); openSettingsSheet(); });
  $('settingsForm').addEventListener('submit', handleSettings);
  $('addOpForm').addEventListener('submit', handleAddOperator);
  $('addPkgForm').addEventListener('submit', handleAddPackage);
  $('changePwdForm').addEventListener('submit', handleChangePassword);
  $('logoutBtn').addEventListener('click', async () => {
    try { await supabaseClient.auth.signOut(); } catch (e) { /* leave anyway */ }
    goLogin();
  });

  $('uploadCloudBtn').addEventListener('click', handleUploadCloud);

  $('installAppBtn').addEventListener('click', () => {
    if (window.FaibaPWA) FaibaPWA.install();
  });
  window.addEventListener('appinstalled', syncInstallRow);

  $('notifBtn').addEventListener('click', () => {
    if (typeof Notification === 'undefined' || !Notification.requestPermission) { toast('Pop-ups are not supported in this browser.'); return; }
    Notification.requestPermission().then(() => {
      updateNotifState();
      toast('Pop-up notifications ' + (Notification.permission === 'granted' ? 'on' : 'off') + '.');
    });
  });
}

init();
