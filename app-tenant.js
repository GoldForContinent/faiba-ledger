/* ===================================================================
   FAIBA LEDGER — app-tenant.js
   -------------------------------------------------------------------
   Read-only self-service page for a tenant. Loaded by tenant.html
   AFTER ledger-core.js. They prove who they are with the phone number
   the owner has on file + the access code the owner generated in the
   manager. They can never write — this page only ever renders.

   In the current local demo, the tenant page reads the same device's
   ledger, so the owner can open it here to test. When hosted on
   Supabase, the same page talks to the backend instead, where access
   codes are verified server-side and row-level security guarantees a
   tenant sees only their own row (SUPABASE_INTEGRATION.md, Phase 2).
=================================================================== */

const $ = id => document.getElementById(id);

const params = new URLSearchParams(location.search);
let current = null; // the tenant whose account is shown

// ---------------------------------------------------------------
// Login
// ---------------------------------------------------------------
let tenantView = 'account';

function showLogin() {
  tenantView = 'account';
  $('loginView').hidden = false;
  $('acctView').hidden = true;
  $('chatView').hidden = true;
  $('tenantNav').hidden = true;
  $('tLogout').hidden = true;
}
function showAccount() {
  $('loginView').hidden = true;
  $('tenantNav').hidden = false;
  $('tLogout').hidden = false;
  switchTenantView('account');
}
function switchTenantView(v) {
  tenantView = v;
  $('acctView').hidden = v !== 'account';
  $('chatView').hidden = v !== 'chat';
  document.querySelectorAll('#tenantNav .nav-tab').forEach(b => b.classList.toggle('is-active', b.dataset.tview === v));
  if (v === 'chat') openChatView();
}
function openChatView() {
  if (!current) return;
  markTenantRead(current);
  renderChat(current);
}
function updateChatBadge() {
  const b = $('tenantChatBadge');
  if (!b) return;
  const n = current
    ? loadMessages().filter(m => m.tenantId === current.id && m.from !== 'tenant' && !m.readByTenant && !threadDeletedFor(m.tenantId, 'tenant')).length
    : 0;
  b.textContent = n;
  b.hidden = n === 0;
}
function markTenantRead(t) {
  const msgs = loadMessages();
  let changed = false;
  msgs.forEach(m => { if (m.tenantId === t.id && m.from !== 'tenant' && !m.readByTenant) { m.readByTenant = true; changed = true; } });
  if (changed) { saveMessages(msgs); updateChatBadge(); }
}

function tErr(msg) {
  const el = $('tErr');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 5000);
}

function findTenantByPhone(phone) {
  const want = normalizePhone(phone);
  if (!want) return null;
  return loadTenantList().find(t => normalizePhone(t.phone) === want) || null;
}

function attemptLogin(phone, pin) {
  const errEl = $('tErr');
  errEl.hidden = true;
  const t = findTenantByPhone(phone);
  if (!t) { tErr('No account matches that phone number. Check the number your owner has for you.'); return; }
  if (!t.accessPin) { tErr('This account has no access code yet — ask your owner to create one (it takes one tap).'); return; }
  if (String(t.accessPin) !== String(pin).trim()) { tErr('That code does not match. Double-check it, or ask the owner to send a new one.'); return; }
  current = t;
  renderAccount(t);
  showAccount();
}

// ---------------------------------------------------------------
// Account rendering (mirrors the manager's numbers, read-only)
// ---------------------------------------------------------------
function renderAccount(t) {
  const a = analyze(t);
  const pkg = pkgOf(latestSeg(t).package);
  const away = isAway(t);

  $('tAvatar').textContent = escapeHtml(initials(t.name));
  $('tAvatar').classList.toggle('away', away);
  $('tName').textContent = t.name;
  $('tUnit').textContent = t.unit || '';
  $('tPkg').textContent = `${pkg.label} · ${money(pkg.price)}`;
  $('tPhoneLine').textContent = t.phone || '';
  $('tStatus').textContent = away ? 'AWAY' : 'ACTIVE';
  $('tStatus').className = 'pill pill-status ' + (away ? 'pill-away' : 'pill-active');

  const sc = $('acState');
  sc.className = 'state-card ' + (a.state === 'owed' ? (a.deepArrears ? 'is-deep' : 'is-owed') : a.state === 'credit' ? 'is-credit' : 'is-clear');
  const stateLabel = a.state === 'owed'
    ? (a.deepArrears ? 'BALANCE OWED · MULTIPLE CYCLES' : 'BALANCE OWED')
    : a.state === 'credit' ? 'YOU ARE PREPAID AHEAD' : 'ALL SETTLED';
  const stateAmt = a.state === 'owed' ? money(a.owed) : a.state === 'credit' ? `+${money(a.credit)}` : money(0);
  const stateCap = a.state === 'owed'
    ? `You still owe ${money(a.owed)} for your ${pkg.label.toLowerCase()} internet. Top up via M-Pesa and send the code to your owner.`
    : a.state === 'credit'
      ? `You have paid ${money(a.credit)} ahead — future cycles are covered until it runs out. Asante!`
      : `You are fully paid up. Asante sana!`;
  sc.innerHTML = `
    <div class="state-label">${stateLabel}</div>
    <div class="state-amt">${stateAmt}</div>
    <div class="state-cap">${stateCap}</div>`;

  const kpi = $('acKpi');
  if (away) {
    const seg = latestSeg(t);
    kpi.innerHTML = `
      <div class="kpi"><span class="kpi-label">Tenure closed</span><span class="kpi-value">${fmtDate(seg.end, true)}</span></div>
      <div class="kpi"><span class="kpi-label">Package</span><span class="kpi-value">${pkg.label} · ${money(pkg.price)}</span></div>
      <div class="kpi kpi-wide"><span class="kpi-cap">You are currently away — nothing is being billed. When you come back, your owner starts a fresh tenure from your arrival day.</span></div>`;
  } else if (a.next) {
    const daysOn = Math.max(1, Math.round((dayMs(todayStr()) - dayMs(a.seg.start)) / DAY_MS) + 1);
    kpi.innerHTML = `
      <div class="kpi"><span class="kpi-label">On the line since</span><span class="kpi-value">${fmtDate(a.seg.start, true)}</span></div>
      <div class="kpi"><span class="kpi-label">Current cycle ends</span><span class="kpi-value">${a.next.dateLabel}</span></div>
      <div class="kpi"><span class="kpi-label">Next cycle charge</span><span class="kpi-value warn-v">${money(a.next.amount)}</span></div>
      <div class="kpi kpi-wide">
        <div class="mini-bar"><i style="width:${Math.round(a.next.progress * 100)}%"></i></div>
        <span class="kpi-cap">${a.next.daysLeft} day${a.next.daysLeft === 1 ? '' : 's'} left in this cycle — your next ${pkg.label.toLowerCase()} charge lands on ${a.next.dateLabel}.</span>
      </div>`;
  }

  const cxSorted = [...a.charges].sort((x, y) => (y.date - x.date) || (y.seq - x.seq)).slice(0, 6);
  $('acCycles').innerHTML = cxSorted.length ? cxSorted.map(c => {
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
  }).join('') : '<li class="cx-more">Nothing billed yet.</li>';

  const pays = [...(t.payments || [])].sort((x, y) => (dayMs(y.date) - dayMs(x.date))).slice(0, 6);
  $('acPays').innerHTML = pays.length ? pays.map(p => `
    <li class="py-row">
      <span class="py-amt">${money(p.amount)}</span>
      <span class="py-meta">
        <span>${fmtDate(p.date, true)}</span>
        ${p.method === 'cash' ? '<span class="py-ref">💵 cash</span>' : (p.ref ? `<span class="py-ref">M-Pesa · ${escapeHtml(p.ref)}</span>` : '')}
      </span>
    </li>`).join('') : '<li class="cx-more">No payments recorded yet.</li>';

  updateChatBadge();
  showAccount();
}

// ---------------------------------------------------------------
// Messaging the owner (quick messages + auto answers)
// ---------------------------------------------------------------
const QUICK_CHIPS = [
  { k: 'down', label: '📴 Internet is down' },
  { k: 'owe', label: '💰 How much do I owe?' },
  { k: 'paid', label: '📲 I have paid' },
];

function tenantMsgs(t) { return loadMessages().filter(m => m.tenantId === t.id); }

function renderChat(t) {
  $('tChips').innerHTML = QUICK_CHIPS.map(c =>
    `<button class="chip" data-k="${c.k}" type="button">${c.label}</button>`).join('');
  $('tChips').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => chatTap(t, b.dataset.k)));
  $('composeInput').value = '';
  $('composeInput').placeholder = 'Type a message…';
  renderThread(t);
  refreshOwnerStatus();
}

function renderThread(t) {
  const box = $('tThread');
  if (threadDeletedFor(t.id, 'tenant')) {
    box.innerHTML = '<div class="chat-deleted"><p>This conversation was deleted from your side.</p><p class="chat-deleted-sub">Your owner still has their copy of the messages. Send a message below anytime to start again.</p></div>';
    return;
  }
  const msgs = tenantMsgs(t);
  box.innerHTML = msgs.length
    ? msgs.map(m => `
      <div class="bubble ${m.from === 'tenant' ? 'is-tenant' : m.from === 'auto' ? 'is-auto' : 'is-owner'}">
        <span class="bubble-text">${escapeHtml(m.text)}</span>
        <span class="bubble-time">${m.from === 'auto' ? '⚡ auto · ' : ''}${new Date(m.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>`).join('')
    : '<p class="chat-empty">No messages yet — say something below.</p>';
  box.scrollTop = box.scrollHeight;
}

function pushMsg(t, m) {
  const msgs = loadMessages();
  msgs.push({ id: uid(), tenantId: t.id, ts: Date.now(), read: false, readByTenant: true, ...m });
  saveMessages(msgs);
  noteNewMessage(t.id);
  const p = loadPresence();
  p.tenants = p.tenants || {};
  p.tenants[t.id] = Date.now();
  savePresence(p);
  renderThread(t);
}

function sendTenantMsg(text) {
  if (!current || !text.trim()) return;
  pushMsg(current, { from: 'tenant', kind: 'other', text: text.trim() });
  $('composeInput').value = '';
  $('composeInput').focus();
}

function chatTap(t, k) {
  if (k === 'down') {
    pushMsg(t, { from: 'tenant', kind: 'down', text: 'My internet is down — please check it.' });
  } else if (k === 'owe') {
    autoAnswer(t);
  } else if (k === 'paid') {
    $('composeInput').placeholder = 'Paste the M-Pesa code you sent (e.g. QWE4R5T6P7)';
    $('composeInput').focus();
  }
}

function autoAnswer(t) {
  const a = analyze(t);
  const pkg = pkgOf(latestSeg(t).package);
  let line;
  if (a.state === 'owed') {
    line = `you owe ${money(a.owed)} (${a.owedNote || 'outstanding'}). ${a.next ? `Your next ${pkg.label.toLowerCase()} charge is ${money(a.next.amount)} on ${a.next.dateLabel}. ` : ''}Once you pay, send the M-Pesa code here and the owner updates your record.`;
  } else if (a.state === 'credit') {
    line = `you are ${money(a.credit)} ahead — nothing is due. Asante!`;
  } else {
    line = isAway(t)
      ? `you are currently away, so nothing is being billed. When you come back the owner starts a fresh tenure.`
      : `you are all settled — nothing due right now. Asante!`;
  }
  const text = `${a.state === 'owed' ? '⚠️' : '✅'} Balance check (auto): ${line}`;
  const msgs = loadMessages();
  msgs.push({ id: uid(), tenantId: t.id, ts: Date.now(), from: 'auto', kind: 'auto', read: true, readByTenant: tenantView === 'chat', text });
  saveMessages(msgs);
  noteNewMessage(t.id);
  updateChatBadge();
  renderThread(t);
}

// Delete this conversation on MY side only — the owner keeps their copy.
function handleTenantDeleteThread() {
  if (!current) return;
  const b = $('tDelThread');
  if (b.dataset.arm === '1') {
    delete b.dataset.arm;
    b.textContent = '🗑 Delete';
    b.classList.remove('btn-danger-ghost');
    b.classList.add('btn-ghost');
    deleteThreadFor(current.id, 'tenant');
    renderThread(current);
    updateChatBadge();
    return;
  }
  b.dataset.arm = '1';
  b.textContent = 'Tap again to delete';
  b.classList.remove('btn-ghost');
  b.classList.add('btn-danger-ghost');
  setTimeout(() => {
    if (b.dataset.arm === '1') {
      delete b.dataset.arm;
      b.textContent = '🗑 Delete';
      b.classList.remove('btn-danger-ghost');
      b.classList.add('btn-ghost');
    }
  }, 4000);
}

// ---------------------------------------------------------------
// Presence (owner online? + my own last-seen heartbeat)
// ---------------------------------------------------------------
function touchMe() {
  if (!current) return;
  const p = loadPresence();
  p.tenants = p.tenants || {};
  p.tenants[current.id] = Date.now();
  savePresence(p);
}
function refreshOwnerStatus() {
  if (!current) return;
  const on = loadPresence().owner;
  $('tOwnerStatus').innerHTML = isOnline(on)
    ? '<span class="dot green"></span> Owner online now — replies fast'
    : 'Owner was last seen ' + fmtAgo(on);
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
function init() {
  $('tLoginForm').addEventListener('submit', e => {
    e.preventDefault();
    attemptLogin($('tPhone').value, $('tPin').value);
  });
  $('tLogout').addEventListener('click', () => {
    current = null;
    $('tPhone').value = '';
    $('tPin').value = '';
    if (history.replaceState) history.replaceState(null, '', location.pathname);
    showLogin();
  });

  $('composeSend').addEventListener('click', () => { if (current) sendTenantMsg($('composeInput').value); });
  $('composeInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && current) { e.preventDefault(); sendTenantMsg($('composeInput').value); } });
  $('tDelThread').addEventListener('click', handleTenantDeleteThread);
  document.querySelectorAll('#tenantNav .nav-tab').forEach(b => b.addEventListener('click', () => switchTenantView(b.dataset.tview)));
  touchMe();
  setInterval(() => {
    if (!current) return;
    touchMe();
    if (tenantView === 'chat') { markTenantRead(current); renderThread(current); refreshOwnerStatus(); }
    else updateChatBadge();
  }, 8000);

  // Modes:
  //   ?demo=1&t=<id>            owner's "Test their page" — opens straight in
  //   ?phone=07..&pin=1234      the link sent via WhatsApp — logs straight in
  if (params.get('demo') === '1' && params.get('t')) {
    const t = loadTenantList().find(x => x.id === params.get('t'));
    if (t) { current = t; renderAccount(t); return; }
  }
  if (params.get('phone') && params.get('pin')) {
    const t = findTenantByPhone(params.get('phone'));
    if (t && String(t.accessPin) === String(params.get('pin')).trim()) {
      current = t;
      renderAccount(t);
      return;
    }
    tErr('That link no longer works — ask your owner to send a fresh one.');
  }
  showLogin();
}

init();
