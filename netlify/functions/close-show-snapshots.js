// Netlify Scheduled Function: close-show-snapshots
// Runs hourly (see netlify.toml). Calls close_ended_show_snapshots(), which writes the
// show_end inventory snapshot for every dealer whose show has a show_start but no
// show_end once the show's last day is over (show's time zone, else Pacific). Dealers
// who tap "End show" on Show Home never need it. See CLAUDE.md "Trades + Show Home".
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY (same as refresh-show-statuses.js).

const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.warn('[close-show-snapshots] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }
  const db = createClient(url, key);
  const { data, error } = await db.rpc('close_ended_show_snapshots');
  if (error) {
    // Before 20261119120000_show_home.sql runs the function doesn't exist; that's not an outage.
    console.error('[close-show-snapshots] RPC failed:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
  console.log(`[close-show-snapshots] wrote ${data} show_end snapshot(s)`);
  return { statusCode: 200, body: JSON.stringify({ closed: data }) };
};
