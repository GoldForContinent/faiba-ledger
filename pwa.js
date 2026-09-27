/* ===================================================================
   FAIBA LEDGER — pwa.js
   -------------------------------------------------------------------
   Everything about being an installed app rather than a web page:

     1. registers the service worker (sw.js) and picks up new versions
     2. catches the browser's install event and turns it into a small
        banner offering "Install"
     3. on iOS - where no such event exists - explains the Share >
        Add to Home Screen route instead
     4. shows a strip while the signal is gone, because the app shell is
        cached but the ledger numbers are not

   Loaded by index.html, login.html and tenant.html with `defer`, so it
   never blocks the app and works identically on all three pages. The
   Settings sheet talks to it through window.FaibaPWA.
=================================================================== */

(function () {
  'use strict';

  // Keep in step with VERSION in sw.js - if they differ the worker is
  // told to take over immediately.
  var SW_VERSION = 'v1';

  var DISMISS_KEY  = 'faiba-pwa-dismissed';
  var DISMISS_MS   = 30 * 24 * 60 * 60 * 1000;
  var BANNER_DELAY = 2500;
  var ICON         = 'icons/icon-192.png';

  var deferred = null;      // the browser's install event, held until asked
  var promptUsed = false;   // true once the user has seen the banner
  var bar = null;
  var sheet = null;

  // ---------------------------------------------------------------
  // Environment
  // ---------------------------------------------------------------
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: minimal-ui)').matches
        || window.navigator.standalone === true;
  }

  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // Can we show the real install dialog? Only Chromium browsers say yes.
  function canPrompt() { return !!deferred; }

  // Anything worth offering at all.
  function canOffer() { return !isStandalone() && (canPrompt() || isIOS()); }

  // ---------------------------------------------------------------
  // Small toast that does not depend on the page having one
  // ---------------------------------------------------------------
  function say(msg, ms) {
    var el = document.getElementById('pwaSay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pwaSay';
      el.className = 'pwa-say';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('is-visible');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('is-visible'); }, ms || 3000);
  }

  // ---------------------------------------------------------------
  // Install
  // ---------------------------------------------------------------
  function install() {
    if (!deferred) { openHelp(); return Promise.resolve('help'); }
    var ev = deferred;
    deferred = null;
    hideBar();
    return ev.prompt()
      .then(function () { return ev.userChoice; })
      .then(function (choice) {
        if (choice && choice.outcome === 'accepted') {
          clearDismiss();
          say('Faiba Ledger installed. Look for it on your home screen.', 4000);
          return 'accepted';
        }
        return 'dismissed';
      })
      .catch(function () { return 'failed'; });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    maybeShowBar();
  });

  window.addEventListener('appinstalled', function () {
    deferred = null;
    clearDismiss();
    hideBar();
    if (isStandalone()) say('Installed. Faiba Ledger now opens from your home screen.', 4000);
  });

  // ---------------------------------------------------------------
  // The banner
  // ---------------------------------------------------------------
  function dismiss(ms) {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); }
    catch (e) { /* private mode - the bar simply comes back next visit */ }
    hideBar();
  }
  function clearDismiss() {
    try { localStorage.removeItem(DISMISS_KEY); } catch (e) {}
  }
  function dismissedRecently() {
    var at = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
    return !!at && (Date.now() - at) < DISMISS_MS;
  }

  function maybeShowBar() {
    if (promptUsed || !canOffer() || dismissedRecently()) return;
    if (!document.body) return;
    promptUsed = true;
    setTimeout(function () { if (canOffer()) showBar(); }, BANNER_DELAY);
  }

  function showBar() {
    if (bar) { bar.hidden = false; requestAnimationFrame(function () { bar.classList.add('is-in'); }); return; }

    bar = document.createElement('div');
    bar.className = 'pwa-bar';
    if (document.querySelector('.bottom-nav')) bar.classList.add('pwa-bar-above-nav');
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Install Faiba Ledger');
    bar.innerHTML =
      '<img class="pwa-bar-icon" src="' + ICON + '" alt="" width="40" height="40">' +
      '<span class="pwa-bar-txt">' +
        '<strong>Install Faiba Ledger</strong>' +
        '<span>Open it from your home screen like a real app — no browser bar, and it loads even with no signal.</span>' +
      '</span>' +
      '<button class="btn btn-primary btn-sm pwa-bar-go" type="button">Install</button>' +
      '<button class="pwa-bar-x" type="button" aria-label="Not now">&times;</button>';

    bar.querySelector('.pwa-bar-go').addEventListener('click', function () { install(); });
    bar.querySelector('.pwa-bar-x').addEventListener('click', function () { dismiss(); });

    document.body.appendChild(bar);
    requestAnimationFrame(function () { bar.classList.add('is-in'); });
  }

  function hideBar() {
    if (!bar) return;
    var el = bar;
    bar = null;
    el.classList.remove('is-in');
    setTimeout(function () { el.remove(); }, 250);
  }

  // ---------------------------------------------------------------
  // Manual install - the button in Settings, and the iOS instructions
  // ---------------------------------------------------------------
  function openHelp() {
    if (isStandalone()) { say('Already installed — you are running the app.'); return; }
    if (sheet) { closeHelp(); return; }
    if (canPrompt()) { install(); return; }

    var steps = isIOS()
      ? ['Tap the <b>Share</b> button in Safari (the square with an arrow pointing up).',
         'Scroll down and tap <b>Add to Home Screen</b>.',
         'Tap <b>Add</b> in the top right.']
      : ['Open your browser menu (<b>⋮</b> or <b>⋯</b>).',
         'Choose <b>Install app</b> or <b>Add to Home screen</b>.',
         'Confirm to add the Faiba Ledger icon.'];

    sheet = document.createElement('div');
    sheet.className = 'pwa-help';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'How to install Faiba Ledger');
    sheet.innerHTML =
      '<div class="pwa-help-scrim"></div>' +
      '<div class="pwa-help-card">' +
        '<div class="sheet-handle"></div>' +
        '<h2 class="pwa-help-title">Put Faiba Ledger on your ' +
          (isIOS() ? 'home screen' : 'device') + '</h2>' +
        '<p class="pwa-help-sub">Then tap the icon to open the ledger full screen — no address bar, and it opens even with no signal.</p>' +
        '<ol class="pwa-help-steps">' +
          steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') +
        '</ol>' +
        '<div class="pwa-help-actions">' +
          '<button class="btn btn-ghost" type="button" data-pwa-close>Got it</button>' +
          '<button class="btn btn-primary" type="button" data-pwa-install>Install</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(sheet);
    requestAnimationFrame(function () { sheet.classList.add('is-in'); });
    sheet.querySelector('[data-pwa-close]').addEventListener('click', closeHelp);
    sheet.querySelector('.pwa-help-scrim').addEventListener('click', closeHelp);
    sheet.querySelector('[data-pwa-install]').addEventListener('click', function () {
      if (canPrompt()) install(); else closeHelp();
    });
    document.addEventListener('keydown', onHelpKey);
  }

  function closeHelp() {
    if (!sheet) return;
    var el = sheet;
    sheet = null;
    document.removeEventListener('keydown', onHelpKey);
    el.classList.remove('is-in');
    setTimeout(function () { el.remove(); }, 200);
  }
  function onHelpKey(e) { if (e.key === 'Escape') closeHelp(); }

  // ---------------------------------------------------------------
  // Offline strip
  // ---------------------------------------------------------------
  // The shell is cached but the ledger data is not, so a dropped signal
  // shows a plain strip rather than a page that looks broken.
  function paintNet() {
    if (!document.body) return;
    var el = document.getElementById('pwaNet');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pwaNet';
      el.className = 'pwa-net';
      el.setAttribute('role', 'status');
      el.innerHTML =
        '<span class="pwa-net-dot" aria-hidden="true"></span>' +
        '<span class="pwa-net-txt">Offline — showing the numbers saved on this device</span>';
      document.body.appendChild(el);
    }
    var off = navigator.onLine === false;
    el.hidden = !off;
    document.documentElement.classList.toggle('is-offline', off);
  }

  window.addEventListener('offline', function () { paintNet(); });
  window.addEventListener('online', function () {
    paintNet();
    say('Back online — catching up with the ledger.', 2500);
  });

  // ---------------------------------------------------------------
  // Service worker
  // ---------------------------------------------------------------
  // Ask a worker which build it is. Answers over the MessageChannel port
  // so a slow or dead worker cannot hang the page.
  function askVersion(worker) {
    return new Promise(function (resolve) {
      if (!worker || typeof MessageChannel === 'undefined') { resolve(null); return; }
      var ch = new MessageChannel();
      var done = false;
      var finish = function (v) { if (done) return; done = true; clearTimeout(timer); resolve(v); };
      var timer = setTimeout(function () { finish(null); }, 1500);
      ch.port1.onmessage = function (e) { finish((e.data && e.data.version) || null); };
      try { worker.postMessage({ type: 'VERSION' }, [ch.port2]); }
      catch (e) { finish(null); }
    });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

    var hadController = !!navigator.serviceWorker.controller;
    var reloaded = false;

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloaded) return;
      reloaded = true;
      if (hasUnsavedTyping()) {            // do not lose a half-typed tenant
        say('A new version is ready — it will load next time you open the app.', 4000);
        return;
      }
      say('New version ready — reopening…', 1500);
      setTimeout(function () { location.reload(); }, 900);
    });

    navigator.serviceWorker.register('sw.js', { scope: './' })
      .then(function (reg) {
        if (reg.waiting && hadController) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        reg.addEventListener('updatefound', function () {
          var next = reg.installing;
          if (!next) return;
          next.addEventListener('statechange', function () {
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              next.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
        // A waiting worker built from a different VERSION is out of step with
        // the shell that is running. Ask which build it is and let it take
        // over, so the page and the caches agree on the next load.
        if (!reg.waiting) return;
        askVersion(reg.waiting).then(function (theirVersion) {
          if (theirVersion && theirVersion !== SW_VERSION) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        }).catch(function () { /* no answer, no problem */ });
      })
      .catch(function () { /* no worker: the app still works, just not offline */ });
  }

  // A text field with something in it means the owner is mid-entry.
  function hasUnsavedTyping() {
    var f = document.querySelector('input[type=text], input[type=number], input[type=tel], textarea');
    return !!(f && String(f.value || '').trim());
  }

  // ---------------------------------------------------------------
  // Public surface for the rest of the app
  // ---------------------------------------------------------------
  window.FaibaPWA = {
    version: SW_VERSION,
    isStandalone: isStandalone,
    isIOS: isIOS,
    isOnline: function () { return navigator.onLine !== false; },
    canOffer: canOffer,
    canPrompt: canPrompt,
    install: install,
    openHelp: openHelp,
    showBanner: function () { promptUsed = false; clearDismiss(); maybeShowBar(); },
    isDismissed: dismissedRecently,
    // Lets app.js offer to retry the moment the signal returns.
    onBackOnline: function (fn) { window.addEventListener('online', fn); }
  };

  registerSW();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { paintNet(); maybeShowBar(); });
  } else {
    paintNet();
    maybeShowBar();
  }
})();
