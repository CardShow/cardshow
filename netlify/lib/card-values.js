// Card pricing service (CardShow Marketplace Phase 1, plan v4).
//
// One value per card and grade, stored once in card_values and copied onto listings.
// Card Hedge's card-match call returns the matched card id plus prices for every grade it
// knows (PSA, BGS, CGC, SGC, TAG, HGA, Raw…), so one call both matches and refreshes a card.
//
// Used by refresh-card-values.js (scheduled) and recalc-pricing-priorities.js.
// Database side: supabase/migrations/20261130120000_marketplace_pricing_search.sql.
//
// Licensing: only Card Hedge values reach card_values (buyers see them). PriceCharting is never
// called here; it stays internal (comp-lookup.js) unless PriceCharting gives written permission.

const CARDHEDGE_BASE = 'https://api.cardhedger.com';
const MATCH_MIN_CONFIDENCE = 0.9;        // same bar as comp-lookup.js: only grade-A matches
const STOP_AT_PCT = 0.9;                 // stop for the day at 90% of the daily limit
const ALERT_AT_PCT = 0.8;                // email once at 80%

function dailyLimit() {
  const n = parseInt(process.env.CARDHEDGE_DAILY_LIMIT || '5000', 10);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}
function perMinuteLimit() {
  const n = parseInt(process.env.CARDHEDGE_PER_MINUTE || '60', 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

// 'psa 10.0' → 'PSA 10', 'BGS 9.50' → 'BGS 9.5', 'Ungraded' / 'raw' → 'Raw'. Matches inventory.grade_key.
function normalizeGrade(label) {
  const s = String(label ?? '').trim();
  if (!s) return null;
  if (/^(raw|ungraded|loose|none)$/i.test(s)) return 'Raw';
  const m = s.match(/^([A-Za-z][A-Za-z .&-]*?)\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const grader = m[1].trim().toUpperCase();
  if (!grader || grader === 'RAW') return 'Raw';
  const num = String(parseFloat(m[2]));
  return `${grader} ${num}`;
}

function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

// Card Hedge prices[] → card_values rows. Unknown shapes are tolerated (undocumented fields).
function pricesToValues(prices) {
  const out = new Map();
  for (const p of Array.isArray(prices) ? prices : []) {
    const grade = normalizeGrade(p?.grade ?? p?.label ?? p?.grade_label);
    const value = toCents(p?.price ?? p?.value ?? p?.fmv);
    if (!grade || !value) continue;
    const row = {
      grade,
      value_cents: value,
      low_cents: toCents(p?.low ?? p?.low_price ?? p?.min),
      high_cents: toCents(p?.high ?? p?.high_price ?? p?.max),
      sales_30d: Number.isFinite(Number(p?.sales_30d ?? p?.sales_count ?? p?.count)) ? Number(p?.sales_30d ?? p?.sales_count ?? p?.count) : null,
      change_30d_pct: Number.isFinite(Number(p?.change_30d ?? p?.change_30d_pct ?? p?.pct_change)) ? Number(p?.change_30d ?? p?.change_30d_pct ?? p?.pct_change) : null,
      source: 'cardhedge',
    };
    if (!out.has(grade)) out.set(grade, row);
  }
  return [...out.values()];
}

// A serial like "17/49" says nothing about which parallel it is; Card Hedge only needs the print run ("/49").
function queryParallel(parallel) {
  return String(parallel ?? '').replace(/\b\d+\s*\/\s*(\d+)\b/g, '/$1').trim();
}

// The print run a card is numbered to: "17/49" or "/49" in the parallel or title → 49.
function printRun(card) {
  const c = card || {};
  for (const t of [c.parallel, c.title]) {
    const m = String(t ?? '').match(/(?:^|[\s#(])\d*\s*\/\s*(\d{1,5})\b/);
    if (m) return Number(m[1]);
  }
  const n = Number(c.print_run);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Words that don't tell one parallel from another.
const GENERIC_PARALLEL_WORDS = new Set(['base', 'parallel', 'variant', 'variation', 'card', 'cards', 'rookie', 'rc', 'auto',
  'autograph', 'autographs', 'the', 'and', 'of', 'ssp', 'sp', 'numbered', 'serial']);

// Is the card Card Hedge matched the same parallel? A card with no parallel and no print run always passes.
// Otherwise the matched title must name the print run ("/49") or every distinctive word of the parallel
// ("Fuchsia Refractor"). Anything else goes to the Pricing tab's "Needs a check" instead of buyers.
function parallelCheck(card, matchedTitle) {
  const c = card || {};
  const run = printRun(c);
  const words = String(c.parallel ?? '').toLowerCase().replace(/\d*\s*\/\s*\d+/g, ' ')
    .split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !/^\d+$/.test(w) && !GENERIC_PARALLEL_WORDS.has(w));
  if (!run && !words.length) return { ok: true };
  const title = String(matchedTitle ?? '').toLowerCase();
  if (!title) return { ok: false, reason: 'parallel_unconfirmed' };
  if (run && new RegExp(`/\\s*0*${run}\\b`).test(title)) return { ok: true };
  if (words.length && words.every(w => title.includes(w))) return { ok: true };
  return { ok: false, reason: 'parallel_unconfirmed' };
}

// The text Card Hedge matches on. Grade is left out on purpose: one match covers every grade.
function buildMatchQuery(card) {
  const c = card || {};
  const num = c.number ? String(c.number).replace(/^#/, '') : '';
  const par = queryParallel(c.parallel);
  const parts = c.player || c.set
    ? [c.year, c.set, c.player, num ? `#${num}` : '', par]
    : [c.title, par];
  return parts.map(v => String(v ?? '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// One Card Hedge call. Returns { ok, cardId, confidence, title, values } or { ok:false, status, error }.
async function cardHedgeMatch(query, { fetchImpl = fetch, apiKey = process.env.CARDHEDGE_API_KEY, timeoutMs = 6000 } = {}) {
  if (!apiKey) return { ok: false, status: 0, error: 'missing_key' };
  if (!query) return { ok: false, status: 0, error: 'empty_query' };
  let res;
  try {
    res = await fetchImpl(`${CARDHEDGE_BASE}/v1/cards/card-match`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err?.name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
  if (!res.ok) return { ok: false, status: res.status, error: `cardhedge_http_${res.status}` };
  let body;
  try { body = await res.json(); } catch { return { ok: false, status: res.status, error: 'bad_json' }; }
  const m = body?.match || body || {};
  const cardId = m.card_id ?? m.id ?? m.cardId ?? null;
  const confidence = typeof m.confidence === 'number' ? m.confidence : (m.confidence != null ? Number(m.confidence) : null);
  const title = m.description ?? m.title ?? m.name ?? m.player ?? null;
  return { ok: true, status: res.status, cardId: cardId != null ? String(cardId) : null, confidence, title,
           values: pricesToValues(m.prices) };
}

// ── Usage / budget ──────────────────────────────────────────────────────────
async function bumpUsage(db, { calls = 1, uncached = 0, errors = 0 } = {}) {
  const { data, error } = await db.rpc('pricing_bump_usage', { p_provider: 'cardhedge', p_calls: calls, p_uncached: uncached, p_errors: errors });
  if (error) { console.warn('[card-values] usage log failed:', error.message); return null; }
  return data;
}

async function usageToday(db) {
  const day = new Date().toISOString().slice(0, 10);
  const { data } = await db.from('pricing_api_usage').select('calls, uncached_calls, errors, alert_sent_at')
    .eq('provider', 'cardhedge').eq('day', day).maybeSingle();
  return data || { calls: 0, uncached_calls: 0, errors: 0 };
}

// Sends the 80% email once per day (through Loops when configured; otherwise logs).
async function maybeAlert(db, calls, { fetchImpl = fetch } = {}) {
  const limit = dailyLimit();
  if (calls < Math.ceil(limit * ALERT_AT_PCT)) return false;
  const { data: first, error } = await db.rpc('pricing_mark_alert', { p_provider: 'cardhedge' });
  if (error || !first) return false;
  const msg = `Card Hedge pricing calls today: ${calls} of ${limit} (${Math.round((calls / limit) * 100)}%). The refresh job stops at 90%.`;
  console.warn('[card-values] usage alert:', msg);
  const key = process.env.LOOPS_API_KEY, tid = process.env.LOOPS_PRICING_ALERT_ID, to = process.env.PRICING_ALERT_EMAIL;
  if (!key || !tid || !to) { console.warn('[card-values] alert email not configured (LOOPS_API_KEY / LOOPS_PRICING_ALERT_ID / PRICING_ALERT_EMAIL)'); return true; }
  try {
    const r = await fetchImpl('https://app.loops.so/api/v1/transactional', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionalId: tid, email: to,
        dataVariables: { provider: 'Card Hedge', calls, limit, percent: Math.round((calls / limit) * 100), message: msg } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) console.warn('[card-values] alert email failed:', r.status);
  } catch (err) { console.warn('[card-values] alert email failed:', err.message); }
  return true;
}

// ── One run of the refresh job ──────────────────────────────────────────────
// Matches newly listed cards (one call per distinct card), then refreshes due cards, on-demand first.
// Stops at 90% of the daily limit, at the per-minute pace, or when the time budget runs out.
async function runRefresh(db, { budgetMs = 20000, fetchImpl = fetch, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const started = now();
  const summary = { matched: 0, review: 0, no_match: 0, match_errors: 0, refreshed: 0, refresh_errors: 0, calls: 0, stopped: null };
  const limit = dailyLimit();
  const stopAt = Math.floor(limit * STOP_AT_PCT);
  let used = (await usageToday(db)).calls || 0;
  const gapMs = Math.ceil(60000 / perMinuteLimit());
  let lastCall = 0;

  const canCall = () => {
    if (used >= stopAt) { summary.stopped = 'daily_limit'; return false; }
    if (now() - started > budgetMs) { summary.stopped = 'time_budget'; return false; }
    return true;
  };
  const call = async (query, uncached) => {
    const wait = lastCall + gapMs - now();
    if (wait > 0) await sleep(wait);
    lastCall = now();
    const r = await cardHedgeMatch(query, { fetchImpl });
    used += 1; summary.calls += 1;
    const tot = await bumpUsage(db, { calls: 1, uncached: uncached ? 1 : 0, errors: r.ok ? 0 : 1 });
    if (tot?.calls) used = Math.max(used, tot.calls);
    return r;
  };

  const { data: work, error } = await db.rpc('pricing_claim_work', { p_match_limit: 20, p_refresh_limit: 40 });
  if (error) throw new Error(`pricing_claim_work: ${error.message}`);

  // On-demand refreshes are served before new matches; then matches; then scheduled refreshes.
  const refresh = Array.isArray(work?.refresh) ? work.refresh : [];
  const onDemand = refresh.filter(r => r.on_demand), scheduled = refresh.filter(r => !r.on_demand);
  const match = Array.isArray(work?.match) ? work.match : [];

  const doRefresh = async (r) => {
    if (!r.query) {
      await db.rpc('pricing_apply_values', { p_card_id: r.card_id, p_values: null, p_error: 'no_query' });
      summary.refresh_errors += 1; return;
    }
    const res = await call(r.query, false);
    if (res.status === 401 || res.status === 403) { summary.stopped = 'auth_error'; throw Object.assign(new Error('cardhedge_auth'), { auth: true }); }
    let err = null;
    if (!res.ok) err = res.error;
    else if (res.cardId && res.cardId !== String(r.card_id)) err = 'card_changed';
    else if (!res.values.length) err = 'no_values';
    const { error: e } = await db.rpc('pricing_apply_values', { p_card_id: r.card_id, p_values: err ? null : res.values, p_error: err });
    if (e) console.warn('[card-values] apply failed:', e.message);
    if (err) summary.refresh_errors += 1; else summary.refreshed += 1;
    if (res.status === 429) { summary.stopped = 'rate_limited'; throw Object.assign(new Error('rate_limited'), { rate: true }); }
  };

  const doMatch = async (m) => {
    const query = buildMatchQuery(m.card);
    if (!query) { await db.rpc('pricing_record_match', { p_identity: m.identity, p_status: 'no_match' }); summary.no_match += 1; return; }
    const res = await call(query, true);
    if (res.status === 401 || res.status === 403) { summary.stopped = 'auth_error'; throw Object.assign(new Error('cardhedge_auth'), { auth: true }); }
    if (!res.ok) {
      await db.rpc('pricing_record_match', { p_identity: m.identity, p_status: 'error' });
      summary.match_errors += 1;
      if (res.status === 429) { summary.stopped = 'rate_limited'; throw Object.assign(new Error('rate_limited'), { rate: true }); }
      return;
    }
    if (!res.cardId || res.confidence == null || res.confidence < MATCH_MIN_CONFIDENCE) {
      await db.rpc('pricing_record_match', { p_identity: m.identity, p_status: 'no_match' });
      summary.no_match += 1; return;
    }
    // Same card, but is it the same parallel? If CardShow can't tell, the value is stored but not shown.
    const check = parallelCheck(m.card, res.title);
    if (check.ok) {
      await db.rpc('pricing_record_match', { p_identity: m.identity, p_status: 'matched', p_card_id: res.cardId, p_query: query, p_title: res.title });
      summary.matched += 1;
    } else {
      await db.rpc('pricing_record_match', { p_identity: m.identity, p_status: 'review', p_card_id: res.cardId, p_query: query,
                                             p_title: res.title, p_reason: check.reason });
      summary.review += 1;
    }
    // The match call already returned every grade's price: store them now (no second call).
    if (res.values.length) {
      await db.rpc('pricing_apply_values', { p_card_id: res.cardId, p_values: res.values, p_error: null });
    }
  };

  const unclaimed = { match: [], refresh: [] };
  try {
    for (const r of onDemand) { if (!canCall()) { unclaimed.refresh.push(r); continue; } await doRefresh(r); }
    for (const m of match) { if (!canCall()) { unclaimed.match.push(m); continue; } await doMatch(m); }
    for (const r of scheduled) { if (!canCall()) { unclaimed.refresh.push(r); continue; } await doRefresh(r); }
  } catch (err) {
    if (!err.auth && !err.rate) throw err;
  }
  summary.calls_today = used;
  summary.daily_limit = limit;
  await maybeAlert(db, used, { fetchImpl });
  // Claims expire on their own after 10 minutes, so anything left over is picked up next run.
  summary.left_for_next_run = unclaimed.match.length + unclaimed.refresh.length;
  return summary;
}

module.exports = {
  normalizeGrade, pricesToValues, buildMatchQuery, parallelCheck, printRun, cardHedgeMatch, runRefresh, maybeAlert, dailyLimit, bumpUsage,
  MATCH_MIN_CONFIDENCE, STOP_AT_PCT, ALERT_AT_PCT,
};
