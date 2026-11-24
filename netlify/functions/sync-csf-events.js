// Netlify Scheduled Function: sync-csf-events. Every 6 hours (netlify.toml): reads The Card Shop Finder's whole
// events feed and syncs CardShow's shows from it (netlify/lib/csf-events.js, 20261210120000_csf_events.sql).
// Needs SUPABASE_URL, SUPABASE_SERVICE_KEY and CSF_API_KEY. CSF_SYNC_ENABLED=false turns it off.
// Netlify won't let a scheduled function be called by URL in production: "Run sync now" in the Show Directory
// goes through csf-feed-admin.js.

const { createClient } = require('@supabase/supabase-js');
const { runSync } = require('../lib/csf-events');

exports.handler = async () => {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.warn('[sync-csf-events] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }
  try {
    const out = await runSync(createClient(url, key), { trigger: 'schedule', budgetMs: 18000, emailBudgetMs: 6000 });
    return { statusCode: 200, body: JSON.stringify(out) };
  } catch (e) {
    console.error('[sync-csf-events]', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
