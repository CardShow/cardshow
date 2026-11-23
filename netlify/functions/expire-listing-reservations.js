// Netlify Scheduled Function: expire-listing-reservations
// Runs every 5 minutes (see netlify.toml). Calls expire_listing_reservations(), which returns expired
// marketplace holds' cards to 'active', then sends the hold emails that are due (netlify/lib/hold-notices.js).
//
// Runs whether or not MARKETPLACE_ENABLED is on: buyers can hold cards as soon as a dealer lists them
// (the dealer listing controls can be tested before launch). Requires SUPABASE_URL + SUPABASE_SERVICE_KEY;
// emails also need LOOPS_API_KEY, LOOPS_HOLD_DEALER_ID and LOOPS_HOLD_BUYER_ID.

const { createClient } = require('@supabase/supabase-js');
const { runHoldNotices } = require('../lib/hold-notices');

exports.handler = async () => {
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
  let notices = null;
  try { notices = await runHoldNotices(db, { budgetMs: 15000 }); }
  catch (e) { console.error('[expire-listing-reservations] hold emails:', e.message); notices = { error: e.message }; }
  if (notices && (notices.due || notices.error)) console.log('[expire-listing-reservations] hold emails', JSON.stringify(notices));
  return { statusCode: 200, body: JSON.stringify({ expired: data, notices }) };
};
