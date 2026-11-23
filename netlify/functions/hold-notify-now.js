// Netlify Function: hold-notify-now. The buyer site (after Hold / Cancel) and the dealer app (after Release /
// Sold to them) call this so the other person's email goes out at once instead of on the next 5-minute run
// of expire-listing-reservations. POST { reservation_id } with Authorization: Bearer <session token>; the
// caller must be the hold's buyer or dealer. Only that hold's due emails are sent.

const { createClient } = require('@supabase/supabase-js');
const { runHoldNotices } = require('../lib/hold-notices');

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
  const id = String(body.reservation_id || '');
  if (!UUID_RE.test(id)) return json(400, { error: 'reservation_id_required' });

  const { data: mine, error: pErr } = await db.rpc('hold_party', { p_reservation_id: id, p_user: u.user.id });
  if (pErr) return json(500, { error: pErr.message });
  if (!mine) return json(404, { error: 'not_found' });
  try {
    return json(200, await runHoldNotices(db, { reservationId: id, fetchImpl: deps.fetchImpl || fetch, budgetMs: 7000 }));
  } catch (e) {
    console.error('[hold-notify-now]', e.message);
    return json(500, { error: e.message });
  }
}

exports.handler = event => handle(event);
exports._test = { handle };
