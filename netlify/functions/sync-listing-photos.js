// Netlify Scheduled Function: sync-listing-photos (every 5 minutes, see netlify.toml).
// Copies listed cards' seller photos to the public listing-photos bucket and deletes public copies that
// must go (delisted, sold, flagged, replaced). See netlify/lib/listing-photos.js.
// Off unless MARKETPLACE_ENABLED is exactly "true". Needs SUPABASE_URL + SUPABASE_SERVICE_KEY.

const { createClient } = require('@supabase/supabase-js');
const { syncListingPhotos } = require('../lib/listing-photos');

exports.handler = async () => {
  if (process.env.MARKETPLACE_ENABLED !== 'true') {
    return { statusCode: 200, body: JSON.stringify({ skipped: 'marketplace_disabled' }) };
  }
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { statusCode: 200, body: JSON.stringify({ skipped: 'not_configured' }) };
  try {
    const out = await syncListingPhotos(createClient(url, key), { limit: 80, budgetMs: 20000 });
    console.log('[sync-listing-photos]', JSON.stringify(out));
    return { statusCode: 200, body: JSON.stringify(out) };
  } catch (e) {
    console.error('[sync-listing-photos]', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
