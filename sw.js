/* ===================================================================
   FAIBA LEDGER — sw.js
   -------------------------------------------------------------------
   Makes the ledger open like an installed app: the shell (html, css,
   js, icons) is precached so launching from the home screen never
   shows a browser error, and Google Fonts / the supabase-js library
   are cached on first use.

   The ledger data itself is NEVER cached. Tenant balances, payments
   and messages must always come from Supabase - a stale balance is
   worse than a spinner, so supabase.co requests go straight to the
   network and are not stored anywhere on the device.

   Load order is irrelevant here: the browser fetches this file.
=================================================================== */

const VERSION   = 'v2';
const SHELL     = `faiba-shell-${VERSION}`;
const VENDOR    = `faiba-vendor-${VERSION}`;
const KEEP      = [SHELL, VENDOR];

// Bump VERSION in pwa.js too - it is how a waiting worker is told to take over.
const PRECACHE = [
  './',
  './index.html',
  './login.html',
  './tenant.html',
  './style.css',
  './pwa.css',
  './pwa.js',
  './app.js',
  './app-tenant.js',
  './ledger-core.js',
  './supabase-client.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

// ------------------------------------------------------------------
// Install - warm the shell, then take over straight away so the very
// first visit is already offline-capable.
// ------------------------------------------------------------------
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // allSettled, not addAll: one missing file must not leave the
    // whole app with no worker at all.
    await Promise.allSettled(
      PRECACHE.map(url => cache.add(new Request(url, { cache: 'reload' })))
    );
    await self.skipWaiting();
  })());
});

// ------------------------------------------------------------------
// Activate - drop caches from older versions, claim open pages.
// ------------------------------------------------------------------
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n.startsWith('faiba-') && !KEEP.includes(n))
           .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

// pwa.js sends { type: ... }; a plain string is accepted too so a manual
// "self.skipWaiting()" from devtools still works. VERSION replies over the
// MessageChannel port when one is given, otherwise back to the page.
self.addEventListener('message', event => {
  const type = (event.data && event.data.type) || event.data;
  if (type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (type !== 'VERSION') return;
  const reply = { type: 'VERSION', version: VERSION };
  if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
  else if (event.source) event.source.postMessage(reply);
});

// ------------------------------------------------------------------
// Routing
// ------------------------------------------------------------------
self.addEventListener('fetch', event => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ledger data + auth + realtime: always live, never stored.
  if (url.hostname.endsWith('supabase.co')) return;
  if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) return;
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(req));
    return;
  }

  event.respondWith(handleAsset(req, url));
});

async function handleNavigate(req) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (e) {
    const path = new URL(req.url).pathname;
    return (await cache.match(req))            // exact page, query string and all
        || (await cache.match(path))           // same page, different query
        || (await cache.match('./' + path.split('/').pop()))
        || offlinePage();
  }
}

// Last resort only: every real page is precached, so this is reached just
// when the shell itself was never stored. Matches the app's dark shell.
function offlinePage() {
  return new Response(
    '<!DOCTYPE html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Offline — Faiba Ledger</title>' +
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;' +
    'background:#05070d;color:#e8eefc;font:15px/1.6 system-ui,sans-serif;text-align:center;padding:24px}' +
    'p{color:#8b96ad;max-width:32ch}</style>' +
    '<div><h1>You are offline</h1>' +
    '<p>Faiba Ledger could not start because this device has never stored the app. ' +
    'Reconnect once and it will work offline from then on.</p></div>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

async function handleAsset(req, url) {
  // Same-origin files: serve from cache immediately, refresh in the
  // background so the next launch is current.
  if (url.origin === self.location.origin) {
    const cached = await caches.match(req);
    const network = fetch(req).then(res => {
      if (res && res.ok) caches.open(SHELL).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('', { status: 504 });
  }

  // Google Fonts + the supabase-js CDN: first load waits, after that
  // it is instant and quietly refreshed.
  const hit = await caches.match(req);
  const network = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) {
      caches.open(VENDOR).then(c => c.put(req, res.clone()));
    }
    return res;
  }).catch(() => null);

  return hit || (await network) || Response.error();
}
