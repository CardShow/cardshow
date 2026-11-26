// Netlify Function: csf-feed-admin. "Run sync now" in the Show Directory's Show feed section (platform owner only).
// POST { action: 'run' } with the platform owner's session → one Card Shop Finder sync (netlify/lib/csf-events.js),
// recorded like a scheduled run (trigger 'manual'). Reading the run log, the match queue and removed shows, and
// linking/rejecting matches, go straight to the database functions (csf_feed_admin, csf_resolve_match,
// csf_removal_handled), which check the platform owner themselves.

const { createClient } = require('@supabase/supabase-js');
const { runSync } = require('../lib/csf-events');

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function requirePlatformAdmin(db, event) {
  const auth = event?.headers?.authorization || event?.headers?.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: row } = await db.from('platform_admins').select('id').eq('id', data.user.id).maybeSingle();
  return row ? data.user : null;
}

async function handle(event, deps = {}) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'post_only' });
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  const db = deps.db || (url && key ? createClient(url, key) : null);
  if (!db) return json(503, { error: 'not_configured' });
  if (!(deps.skipAuth || await requirePlatformAdmin(db, event))) return json(403, { error: 'platform_owner_only' });
  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }
  if (b.action !== 'run') return json(400, { error: 'bad_action' });
  try {
    // Plain functions get ~10s: a short fetch budget, emails left for the next run if time is short.
    const out = await runSync(db, { trigger: 'manual', budgetMs: 6000, emailBudgetMs: 1500, ...(deps.syncOpts || {}) });
    return json(200, out);
  } catch (e) {
    return json(500, { error: 'sync_failed', message: e.message });
  }
}

exports.handler = event => handle(event);
exports.handle = handle;

// Assistant (OAuth) tokens are for the seller MCP server only.
exports.handler = require('../lib/oauth-guard').refuseOAuthClient(exports.handler);
