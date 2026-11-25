// Netlify Scheduled Function: expire-listing-reservations
// Runs every 5 minutes (see netlify.toml). Calls expire_listing_reservations(), which returns expired
// marketplace holds' cards to 'active', and expire_offers(), which ends unanswered offers and closes offers on cards
// no longer for sale, and expire_orders() (first), which ends Buy Now orders not confirmed or paid in time. Then sends the hold and offer emails that are due (netlify/lib/hold-notices.js, offer-notices.js).
//
// Runs whether or not MARKETPLACE_ENABLED is on: buyers can hold cards as soon as a dealer lists them
// (the dealer listing controls can be tested before launch). Requires SUPABASE_URL + SUPABASE_SERVICE_KEY;
// emails also need LOOPS_API_KEY, LOOPS_HOLD_DEALER_ID and LOOPS_HOLD_BUYER_ID.

const { createClient } = require('@supabase/supabase-js');
const { runHoldNotices } = require('../lib/hold-notices');
const { runOfferNotices } = require('../lib/offer-notices');
const { runOrderNotices } = require('../lib/order-notices');
const { sendShowFeedNotices } = require('../lib/csf-events');

exports.handler = async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.warn('[expire-listing-reservations] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  const db = createClient(url, key);
  // Orders first (20261212120000): an order's reservation runs a day past its deadlines, but ending the order here
  // first keeps its status right. Missing before that migration runs: logged, the rest carries on.
  let ordersEnded = null;
  const ordRes = await db.rpc('expire_orders');
  if (ordRes.error) console.warn('[expire-listing-reservations] expire_orders:', ordRes.error.message);
  else { ordersEnded = ordRes.data; if (ordersEnded) console.log(`[expire-listing-reservations] ended ${ordersEnded} order(s)`); }
  const { data, error } = await db.rpc('expire_listing_reservations');
  if (error) {
    console.error('[expire-listing-reservations] RPC failed:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
  if (data) console.log(`[expire-listing-reservations] expired ${data} hold(s)`);
  // Offers (20261208120000). Missing before that migration runs: logged, holds carry on.
  let offersEnded = null;
  const offRes = await db.rpc('expire_offers');
  if (offRes.error) console.warn('[expire-listing-reservations] expire_offers:', offRes.error.message);
  else { offersEnded = offRes.data; if (offersEnded) console.log(`[expire-listing-reservations] ended ${offersEnded} offer(s)`); }
  let notices = null;
  try { notices = await runHoldNotices(db, { budgetMs: 12000 }); }
  catch (e) { console.error('[expire-listing-reservations] hold emails:', e.message); notices = { error: e.message }; }
  if (notices && (notices.due || notices.error)) console.log('[expire-listing-reservations] hold emails', JSON.stringify(notices));
  let offerNotices = null;
  if (!offRes.error) {
    try { offerNotices = await runOfferNotices(db, { budgetMs: 8000 }); }
    catch (e) { console.error('[expire-listing-reservations] offer emails:', e.message); offerNotices = { error: e.message }; }
    if (offerNotices && (offerNotices.due || offerNotices.error)) console.log('[expire-listing-reservations] offer emails', JSON.stringify(offerNotices));
  }
  let orderNotices = null;
  if (!ordRes.error) {
    try { orderNotices = await runOrderNotices(db, { budgetMs: 8000 }); }
    catch (e) { console.error('[expire-listing-reservations] order emails:', e.message); orderNotices = { error: e.message }; }
    if (orderNotices && (orderNotices.due || orderNotices.error)) console.log('[expire-listing-reservations] order emails', JSON.stringify(orderNotices));
  }
  // Emails about Card Shop Finder shows taken down (20261210120000); retried here between the 6-hourly syncs.
  let feedNotices = null;
  try { feedNotices = await sendShowFeedNotices(db, { budgetMs: 4000 }); }
  catch (e) { feedNotices = { error: e.message }; }
  if (feedNotices && feedNotices.due) console.log('[expire-listing-reservations] show feed emails', JSON.stringify(feedNotices));
  return { statusCode: 200, body: JSON.stringify({ expired: data, offers_ended: offersEnded, orders_ended: ordersEnded, notices, offerNotices, orderNotices, feedNotices }) };
};
