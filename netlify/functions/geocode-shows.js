// Netlify Function: geocode-shows. Sets shows.latitude / longitude so marketplace search can find
// "cards at shows within X miles" (Marketplace Phase 1). Uses US Census data only (netlify/lib/geocode.js).
//
//   Scheduled (hourly, see netlify.toml): shows not located yet (geo_source null) with a city and
//   state, that haven't ended, upcoming first; up to 40 per run.
//   POST { show_id } with an admin's session token: locate one show now (the Show Directory calls
//   this after a save). Returns the result.
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_KEY. No API key: the Census Geocoder is free.
// Coordinates can only be written by the service role or the platform owner (trigger shows_geo_a_guard),
// and are cleared when the street address, city, state or ZIP changes (shows_geo_b_reset).

const { createClient } = require('@supabase/supabase-js');
const { geocodeShow } = require('../lib/geocode');

const COLS = 'id, name, street_address, postal_code, city, state, end_date, start_date, geo_source';

async function requireAdmin(db, event) {
  const auth = event?.headers?.authorization || event?.headers?.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  const uid = data.user.id;
  const [{ data: a }, { data: p }] = await Promise.all([
    db.from('admins').select('id').eq('id', uid).maybeSingle(),
    db.from('platform_admins').select('id').eq('id', uid).maybeSingle(),
  ]);
  return a || p ? data.user : null;
}

async function saveResult(db, id, r) {
  const row = { latitude: r.latitude, longitude: r.longitude, geo_source: r.geo_source, geo_query: r.geo_query,
                geo_error: r.geo_error, geocoded_at: new Date().toISOString() };
  const { error } = await db.from('shows').update(row).eq('id', id);
  if (error) throw new Error(`save ${id}: ${error.message}`);
}

async function runBatch(db, { limit = 40, budgetMs = 20000, now = () => Date.now(), fetchImpl } = {}) {
  const started = now();
  const today = new Date().toISOString().slice(0, 10);
  const { data: rows, error } = await db.from('shows').select(COLS)
    .is('geo_source', null).not('city', 'is', null).not('state', 'is', null)
    .or(`end_date.gte.${today},end_date.is.null`)
    .order('start_date', { ascending: true, nullsFirst: false }).limit(limit);
  if (error) throw new Error(`load shows: ${error.message}`);
  const out = { checked: 0, address: 0, place: 0, not_found: 0, retry: 0 };
  for (const s of rows || []) {
    if (now() - started > budgetMs) break;
    const r = await geocodeShow(s, { fetchImpl });
    out.checked += 1;
    if (!r.geo_source) { out.retry += 1; continue; }   // Census down: leave it for the next run
    await saveResult(db, s.id, r);
    out[r.geo_source === 'census_address' ? 'address' : r.geo_source === 'census_place' ? 'place' : 'not_found'] += 1;
  }
  return out;
}

async function handler(event, deps = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  const db = deps.db || (url && key ? createClient(url, key) : null);
  if (!db) return { statusCode: 200, body: JSON.stringify({ skipped: 'no_service_key' }) };

  if (event?.httpMethod === 'POST') {
    const user = deps.skipAuth ? { id: 'test' } : await requireAdmin(db, event);
    if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'admin_only' }) };
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* empty */ }
    if (!body.show_id) return { statusCode: 400, body: JSON.stringify({ error: 'show_id_required' }) };
    const { data: s, error } = await db.from('shows').select(COLS).eq('id', String(body.show_id)).maybeSingle();
    if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    if (!s) return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
    const r = await geocodeShow(s, { fetchImpl: deps.fetchImpl });
    if (r.geo_source) await saveResult(db, s.id, r);
    return { statusCode: 200, body: JSON.stringify({ ok: true, show_id: s.id, ...r }) };
  }

  try {
    const out = await runBatch(db, { fetchImpl: deps.fetchImpl });
    console.log('[geocode-shows]', JSON.stringify(out));
    return { statusCode: 200, body: JSON.stringify(out) };
  } catch (err) {
    console.error('[geocode-shows]', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

exports.handler = (event) => handler(event);
exports._test = { handler, runBatch };
