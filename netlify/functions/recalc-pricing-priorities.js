// Netlify Scheduled Function: recalc-pricing-priorities (daily, see netlify.toml).
// Counts each card's active listings and sets its refresh priority: high (at a show in the next
// 7 days, $250+, or 10+ sales in 30 days) → daily; normal → every 3 days ($50+) or 7 days;
// dormant (no active listings) → only when someone views a listing.
// Off unless MARKETPLACE_ENABLED is exactly "true". Needs SUPABASE_URL + SUPABASE_SERVICE_KEY.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
  if (process.env.MARKETPLACE_ENABLED !== 'true') return { statusCode: 200, body: JSON.stringify({ skipped: 'marketplace_disabled' }) };
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { statusCode: 200, body: JSON.stringify({ skipped: 'no_service_key' }) };
  const db = createClient(url, key);
  const { data, error } = await db.rpc('pricing_recalc_priorities');
  if (error) { console.error('[recalc-pricing-priorities]', error.message); return { statusCode: 500, body: JSON.stringify({ error: error.message }) }; }
  console.log('[recalc-pricing-priorities]', JSON.stringify(data));
  return { statusCode: 200, body: JSON.stringify(data) };
};
