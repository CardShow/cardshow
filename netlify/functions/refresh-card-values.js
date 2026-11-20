// Netlify Scheduled Function: refresh-card-values (every 5 minutes, see netlify.toml).
// CardShow Marketplace Phase 1 — card pricing service. Matches newly listed cards to Card Hedge
// (one call per distinct card, which also returns every grade's value) and refreshes due cards,
// on-demand requests first. Stops for the day at 90% of CARDHEDGE_DAILY_LIMIT; emails at 80%.
//
// Off unless MARKETPLACE_ENABLED is exactly "true". Needs SUPABASE_URL, SUPABASE_SERVICE_KEY,
// CARDHEDGE_API_KEY (commercial license). An admin can also POST with their session token to run
// it once (deploy previews don't run scheduled functions).

const { createClient } = require('@supabase/supabase-js');
const { runRefresh } = require('../lib/card-values');

async function isAdmin(db, event) {
  const auth = event?.headers?.authorization || event?.headers?.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return false;
  const { data: row } = await db.from('admins').select('id').eq('id', data.user.id).maybeSingle();
  return !!row;
}

exports.handler = async (event) => {
  const manual = event?.httpMethod === 'POST';
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { statusCode: 200, body: JSON.stringify({ skipped: 'no_service_key' }) };
  const db = createClient(url, key);
  if (manual && !(await isAdmin(db, event))) return { statusCode: 403, body: JSON.stringify({ error: 'admin_only' }) };
  if (!manual && process.env.MARKETPLACE_ENABLED !== 'true') {
    return { statusCode: 200, body: JSON.stringify({ skipped: 'marketplace_disabled' }) };
  }
  if (!process.env.CARDHEDGE_API_KEY) return { statusCode: 200, body: JSON.stringify({ skipped: 'no_cardhedge_key' }) };
  try {
    const summary = await runRefresh(db, { budgetMs: manual ? 7000 : 20000 });
    console.log('[refresh-card-values]', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    console.error('[refresh-card-values] failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
