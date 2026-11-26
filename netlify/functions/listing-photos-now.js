// Netlify Function: listing-photos-now. The dealer app calls this right after listing or taking cards off,
// so the public photo appears (or goes) at once instead of on the next 5-minute run of sync-listing-photos.
// POST { ids: [card uuid…] } with Authorization: Bearer <seller session token>. Only the caller's own cards
// are touched. Works whether or not MARKETPLACE_ENABLED is on (dealers list before launch).

const { createClient } = require('@supabase/supabase-js');
const { syncListingPhotos } = require('../lib/listing-photos');

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handle(event, deps = {}) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'post_only' });
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  const db = deps.db || (url && key ? createClient(url, key) : null);
  if (!db) return json(503, { error: 'not_configured' });

  const token = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'sign_in_required' });
  const { data: u, error: uErr } = await db.auth.getUser(token);
  if (uErr || !u?.user) return json(401, { error: 'sign_in_required' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).filter(x => UUID_RE.test(String(x))))].slice(0, 200);
  if (!ids.length) return json(400, { error: 'ids_required' });

  const { data: own, error: oErr } = await db.from('inventory').select('id').in('id', ids).eq('seller_id', u.user.id);
  if (oErr) return json(500, { error: oErr.message });
  const mine = (own || []).map(r => r.id);
  if (!mine.length) return json(200, { added: 0, removed: 0, failed: 0 });
  try {
    return json(200, await syncListingPhotos(db, { ids: mine, limit: mine.length, budgetMs: 8000 }));
  } catch (e) {
    console.error('[listing-photos-now]', e.message);
    return json(500, { error: e.message });
  }
}

exports.handler = event => handle(event);
exports._test = { handle };

// Assistant (OAuth) tokens are for the seller MCP server only.
exports.handler = require('../lib/oauth-guard').refuseOAuthClient(exports.handler);
