// Netlify Function: pricing-admin. Backs the "💲 Pricing" admin tab (platform owner only).
// The Card Hedge key stays here; everything else is the database functions in
// 20261202120000_pricing_admin.sql, called with the service key after checking the caller.
//
// POST (Authorization: Bearer <platform owner's session token>)
//   { action: 'summary' }                          → pricing_admin_summary() + daily limit
//   { action: 'queue', status: 'check'|'open'|'auto'|'manual'|'ignored' } → pricing_unmatched()
//   { action: 'lookup', query }                    → one Card Hedge card-match call (counted in pricing_api_usage):
//                                                     { card_id, confidence, title, values: [{grade, value_cents}] }
//   { action: 'match', identity, card_id, query, title, values? } → link every listing of that card to it and
//                                                     store the values from the lookup (no second Card Hedge call)
//   { action: 'retry' | 'ignore', identity }       → back to the automatic queue / hide (no comp)
//   { action: 'confirm', identity }                → the automatic match is right: show its value
//   { action: 'run' }                              → one pass of the automatic pricing job now (same as the
//                                                     5-minute refresh-card-values schedule, ~7s budget). Netlify
//                                                     won't let a scheduled function be called by URL in production,
//                                                     so this is how the platform owner runs it by hand.
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_KEY; 'lookup' also needs CARDHEDGE_API_KEY. Works whether or not
// MARKETPLACE_ENABLED is on (fixing matches before launch is the point).

const { createClient } = require('@supabase/supabase-js');
const { cardHedgeMatch, bumpUsage, dailyLimit, normalizeGrade, runRefresh } = require('../lib/card-values');

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

// Values from the lookup, checked before they're stored (grade labels normalized, whole cents, sane range).
function cleanValues(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const v of values.slice(0, 40)) {
    const grade = normalizeGrade(v?.grade);
    const cents = Math.round(Number(v?.value_cents));
    if (!grade || !Number.isFinite(cents) || cents <= 0 || cents > 100000000) continue;
    const opt = k => (Number.isFinite(Number(v?.[k])) && Number(v[k]) > 0 ? Math.round(Number(v[k])) : null);
    out.push({ grade, value_cents: cents, low_cents: opt('low_cents'), high_cents: opt('high_cents'),
               sales_30d: Number.isInteger(v?.sales_30d) ? v.sales_30d : null, source: 'cardhedge' });
  }
  return out;
}

async function handle(event, deps = {}) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'post_only' });
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  const db = deps.db || (url && key ? createClient(url, key) : null);
  if (!db) return json(503, { error: 'not_configured' });
  const user = deps.skipAuth ? { id: 'test' } : await requirePlatformAdmin(db, event);
  if (!user) return json(403, { error: 'platform_owner_only' });

  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }
  const rpc = async (name, args) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return data;
  };

  try {
    switch (b.action) {
      case 'summary':
        return json(200, { ...(await rpc('pricing_admin_summary', {})), daily_limit: dailyLimit(),
                           cardhedge_key: !!process.env.CARDHEDGE_API_KEY, enabled: process.env.MARKETPLACE_ENABLED === 'true' });
      case 'queue':
        return json(200, { rows: await rpc('pricing_unmatched', { p_status: ['check', 'auto', 'ignored', 'manual'].includes(b.status) ? b.status : 'open', p_limit: 200 }) });
      case 'lookup': {
        const query = String(b.query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!query) return json(400, { error: 'query_required' });
        if (!process.env.CARDHEDGE_API_KEY) return json(503, { error: 'no_cardhedge_key' });
        const r = await (deps.cardHedgeMatch || cardHedgeMatch)(query, { fetchImpl: deps.fetchImpl });
        await bumpUsage(db, { calls: 1, uncached: 1, errors: r.ok ? 0 : 1 });
        if (!r.ok) return json(502, { error: r.error });
        if (!r.cardId) return json(200, { found: false });
        return json(200, { found: true, card_id: r.cardId, confidence: r.confidence, title: r.title, values: r.values, query });
      }
      case 'match': {
        if (!b.identity || !b.card_id) return json(400, { error: 'identity_and_card_id_required' });
        const res = await rpc('pricing_admin_resolve', { p_identity: String(b.identity), p_action: 'match',
          p_card_id: String(b.card_id), p_query: b.query ? String(b.query).slice(0, 200) : null,
          p_title: b.title ? String(b.title).slice(0, 200) : null });
        const values = cleanValues(b.values);
        if (values.length) {
          await rpc('pricing_apply_values', { p_card_id: String(b.card_id), p_values: values, p_error: null });
        } else {
          // Nothing to store yet: ask the refresh job for this card's values.
          await db.from('pricing_cards').update({ requested_at: new Date().toISOString() }).eq('card_id', String(b.card_id));
        }
        return json(200, { ok: true, listings: res?.listings ?? 0, values: values.length });
      }
      case 'run': {
        if (!process.env.CARDHEDGE_API_KEY) return json(503, { error: 'no_cardhedge_key' });
        const summary = await (deps.runRefresh || runRefresh)(db, { budgetMs: 7000, fetchImpl: deps.fetchImpl });
        console.log('[pricing-admin] run', JSON.stringify(summary));
        return json(200, { summary });
      }
      case 'retry':
      case 'confirm':
      case 'ignore': {
        if (!b.identity) return json(400, { error: 'identity_required' });
        return json(200, await rpc('pricing_admin_resolve', { p_identity: String(b.identity), p_action: b.action }));
      }
      default:
        return json(400, { error: 'bad_action' });
    }
  } catch (err) {
    console.error('[pricing-admin]', b.action, err.message);
    return json(err.status || 500, { error: err.message });
  }
}

exports.handler = (event) => handle(event);
exports._test = { handle, cleanValues };
