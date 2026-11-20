// Netlify Scheduled Function: expire-listing-reservations
// Runs every 5 minutes (see netlify.toml). Calls expire_listing_reservations(), which
// returns expired marketplace holds' cards to 'active' (CardShow Marketplace, Phase 0).
//
// Off unless MARKETPLACE_ENABLED is exactly "true" (no holds exist until the marketplace is on).
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
  if (process.env.MARKETPLACE_ENABLED !== 'true') {
    return { statusCode: 200, body: JSON.stringify({ skipped: 'marketplace_disabled' }) };
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.warn('[expire-listing-reservations] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  const db = createClient(url, key);
  const { data, error } = await db.rpc('expire_listing_reservations');
  if (error) {
    console.error('[expire-listing-reservations] RPC failed:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
  if (data) console.log(`[expire-listing-reservations] expired ${data} hold(s)`);
  return { statusCode: 200, body: JSON.stringify({ expired: data }) };
};
