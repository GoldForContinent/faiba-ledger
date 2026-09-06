/* ===================================================================
   FAIBA LEDGER — supabase-client.js
   -------------------------------------------------------------------
   The single place that knows the Supabase project. The publishable
   key is safe to ship in a browser (it only enables the RLS-scoped
   queries the app is allowed to make — everything sensitive is locked
   by row-level security in the database, not by this key).
   Load AFTER the supabase-js CDN script, BEFORE ledger-core.js.

   NAMING: the supabase-js UMD build declares a global `var supabase`
   (the module namespace — it has createClient, but no .from or .auth).
   We must NOT redeclare that name, so the configured client lives here
   as `supabaseClient` and every page uses that.
=================================================================== */

const SUPABASE_URL = 'https://zmzsahvhczzxqobiqjzj.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_FHvAx-yWQqLRnFkO8i83Nw__9gqzAuA';
const SUPABASE_REF = 'zmzsahvhczzxqobiqjzj';

let _client = null;

function initSupabaseClient() {
  if (!_client && window.supabase && window.supabase.createClient) {
    _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  }
  return _client;
}

// The configured client — ready for app.js and login.html to use.
const supabaseClient = initSupabaseClient();

// Synchronous check used by the <head> guard on index.html — supabase-js
// persists the session token in localStorage under this key.
function hasSupabaseSession() {
  return !!localStorage.getItem('sb-' + SUPABASE_REF + '-auth-token');
}