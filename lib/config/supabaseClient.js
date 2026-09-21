// FILE: lib/config/supabaseClient.js
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Detect obvious placeholder Supabase credentials (e.g. the checked-in
// .env.example values). When these look like placeholders and a real
// DATABASE_URL is configured, fall back to the pg-backed shim
// (lib/config/pgSupabaseShim.js) instead of instantiating a Supabase client
// that would try to resolve a non-existent https://your-project.supabase.co
// host at query time.
function looksLikePlaceholder(url, key) {
  if (!url || !key) return true;
  const placeholderMarkers = ['your-project', 'your-service-role-key', 'placeholder', 'example'];
  const lowerUrl = url.toLowerCase();
  const lowerKey = key.toLowerCase();
  return placeholderMarkers.some(m => lowerUrl.includes(m) || lowerKey.includes(m));
}

function looksLikeRealDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return false;
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) return false;
  const lower = databaseUrl.toLowerCase();
  return !['your-project', 'placeholder', 'example', 'user:password@host'].some(m => lower.includes(m));
}

let supabase = null;

if (!looksLikePlaceholder(supabaseUrl, supabaseKey)) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else if (looksLikeRealDatabaseUrl(process.env.DATABASE_URL)) {
  const { makeShim } = require('./pgSupabaseShim');
  supabase = makeShim(process.env.DATABASE_URL);
} else if (supabaseUrl && supabaseKey) {
  // Neither real Supabase creds nor a real DATABASE_URL are available —
  // preserve prior behavior (attempt a real client) so errors surface clearly.
  supabase = createClient(supabaseUrl, supabaseKey);
}

module.exports = { supabase };
