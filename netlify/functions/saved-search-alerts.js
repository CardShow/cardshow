// Netlify Scheduled Function: saved-search-alerts (hourly, see netlify.toml).
// For each saved search with alerts on, last checked an hour or more ago: finds listings that went
// live since the last check (search_listings with listed_after) and emails the buyer through Loops.
// At most one email per search per hour.
//
// Off unless MARKETPLACE_ENABLED is exactly "true". Needs SUPABASE_URL, SUPABASE_SERVICE_KEY,
// LOOPS_API_KEY and LOOPS_SAVED_SEARCH_ID (a Loops transactional email). Without the Loops settings
// nothing is marked checked, so no alerts are lost before email is set up.

const { createClient } = require('@supabase/supabase-js');

const SITE = () => (process.env.MARKETPLACE_SITE_URL || 'https://getcardshow.com').replace(/\/$/, '');
const money = c => (c == null ? '' : `$${(c / 100).toFixed(2).replace(/\.00$/, '')}`);

async function runAlerts(db, { fetchImpl = fetch, budgetMs = 20000, now = () => Date.now() } = {}) {
  const key = process.env.LOOPS_API_KEY, tid = process.env.LOOPS_SAVED_SEARCH_ID;
  if (!key || !tid) return { skipped: 'loops_not_configured' };
  const started = now();
  const { data: due, error } = await db.rpc('saved_searches_due', { p_limit: 200 });
  if (error) throw new Error(`saved_searches_due: ${error.message}`);
  const out = { checked: 0, emailed: 0, failed: 0 };
  for (const s of due || []) {
    if (now() - started > budgetMs) break;
    const checkedAt = new Date().toISOString();
    const params = { ...(s.params || {}), listed_after: s.last_checked_at, sort: 'newest', limit: 5, offset: 0 };
    const { data: res, error: e } = await db.rpc('search_listings', { p: params });
    if (e) { out.failed += 1; continue; }
    let alerted = false;
    if (res?.total > 0 && s.email) {
      const items = (res.results || []).map(r => ({
        title: r.title, price: money(r.price_cents),
        comp: r.comp ? money(r.comp.value_cents) : '', url: `${SITE()}${r.url}`,
      }));
      try {
        const r = await fetchImpl('https://app.loops.so/api/v1/transactional', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactionalId: tid, email: s.email, dataVariables: {
            searchName: s.name, count: res.total,
            firstTitle: items[0]?.title || '', firstPrice: items[0]?.price || '', firstUrl: items[0]?.url || '',
            listText: items.map(i => `${i.title} · ${i.price}${i.comp ? ` (comp ${i.comp})` : ''}\n${i.url}`).join('\n\n'),
            searchUrl: `${SITE()}/search?saved=${s.id}`,
          } }),
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) { out.failed += 1; continue; }   // retried next hour (not marked checked)
        alerted = true; out.emailed += 1;
      } catch { out.failed += 1; continue; }
    }
    await db.rpc('saved_search_checked', { p_id: s.id, p_checked_at: checkedAt, p_alerted: alerted });
    out.checked += 1;
  }
  return out;
}

exports.runAlerts = runAlerts;
exports.handler = async () => {
  if (process.env.MARKETPLACE_ENABLED !== 'true') return { statusCode: 200, body: JSON.stringify({ skipped: 'marketplace_disabled' }) };
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { statusCode: 200, body: JSON.stringify({ skipped: 'no_service_key' }) };
  try {
    const out = await runAlerts(createClient(url, key));
    console.log('[saved-search-alerts]', JSON.stringify(out));
    return { statusCode: 200, body: JSON.stringify(out) };
  } catch (err) {
    console.error('[saved-search-alerts]', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
