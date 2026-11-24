// The Card Shop Finder (CSF) Partner Events API → CardShow shows. See CLAUDE.md "Card Shop Finder events".
//
// runSync(): fetches the whole feed (limit=1000, paging until next_offset is null), checks it's complete, then hands
// every event to csf_sync_apply() (20261210120000_csf_events.sql), which upserts external_events, marks events that
// left the feed ended/removed, creates/links shows and queues the emails for removed shows with pickups. Each run is
// one external_sync_runs row. Then sends the queued emails (sendShowFeedNotices).
//
// The key: process.env.CSF_API_KEY, sent only in the X-API-Key header (never ?key=). Never logged, never stored,
// never in an error message (the request URL has no key in it). CSF_SYNC_ENABLED=false turns the sync off.

const API = 'https://thecardshopfinder.com/api/partner/events.php';
const PAGE = 1000;
const MAX_PAGES = 10;
// Event types that become CardShow shows. 'pokemon' events are kept in external_events but get no show (mostly
// store tournaments with no dealer tables).
const SHOW_TYPES = ['card_show', 'sports', 'convention'];
// The listing facts we keep; anything else CSF sends is dropped before it reaches the database.
const FIELDS = ['id', 'name', 'type', 'date_start', 'date_end', 'time_start', 'time_end', 'venue', 'address', 'city', 'state',
  'postal_code', 'lat', 'lng', 'admission_price', 'featured', 'updated_at', 'url'];

const SITE = () => (process.env.MARKETPLACE_SITE_URL || 'https://getcardshow.com').replace(/\/$/, '');
const pickEvent = e => Object.fromEntries(FIELDS.map(k => [k, e?.[k] ?? null]));

class FeedError extends Error {
  constructor(code, message, httpStatus = null) { super(message); this.code = code; this.httpStatus = httpStatus; }
}

async function fetchPage(offset, { key, fetchImpl, sleep, deadline }) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${API}?limit=${PAGE}&offset=${offset}`, {
        headers: { 'X-API-Key': key, Accept: 'application/json', 'User-Agent': 'CardShow events sync' },
        signal: AbortSignal.timeout(Math.max(2000, Math.min(10000, deadline - Date.now()))),
      });
    } catch (e) {
      throw new FeedError('network', `Couldn't reach The Card Shop Finder (${e.name === 'TimeoutError' ? 'timed out' : 'network error'})`);
    }
    if (res.status === 401) throw new FeedError('key_rejected', 'CSF key rejected (401): missing, wrong or switched off', 401);
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      // Wait inside this run only for a short pause; otherwise the next scheduled run tries.
      if (attempt === 0 && Number.isFinite(wait) && wait <= 15 && Date.now() + wait * 1000 + 3000 < deadline) {
        await sleep(wait * 1000); continue;
      }
      throw new FeedError('rate_limited', `Daily limit reached (429), retry after ${Number.isFinite(wait) ? wait + 's' : 'an unknown wait'}`, 429);
    }
    let body = null;
    let text = '';
    try { text = await res.text(); body = JSON.parse(text); } catch { body = null; /* not JSON */ }
    if (!res.ok) {
      // CSF's own errors are JSON {ok:false, error}. Anything else (an HTML page) came from in front of the API,
      // usually Cloudflare blocking the request before it reached CSF: say so, with what we can see of it.
      if (body && typeof body === 'object' && 'ok' in body) {
        throw new FeedError('http_' + res.status, `CSF answered ${res.status}${body.error ? ': ' + String(body.error).slice(0, 200) : ''}`, res.status);
      }
      const server = res.headers.get('server') || '';
      const ray = res.headers.get('cf-ray') || '';
      const ctype = (res.headers.get('content-type') || '').split(';')[0];
      const title = (/<title>([^<]{0,120})<\/title>/i.exec(text) || [])[1] || '';
      const blocked = /cloudflare/i.test(server) || ray || /attention required|access denied|just a moment|blocked/i.test(title);
      const detail = [server && `server ${server}`, ray && `cf-ray ${ray}`, ctype && `type ${ctype}`, title && `page "${title.trim()}"`]
        .filter(Boolean).join(', ');
      throw new FeedError(blocked ? 'blocked' : 'http_' + res.status,
        blocked
          ? `Blocked before reaching the CSF API (HTTP ${res.status}${detail ? '; ' + detail : ''}). The site's firewall is refusing our server; ask The Card Shop Finder to allow requests to /api/partner/events.php that carry a valid X-API-Key.`
          : `CSF answered ${res.status} without its usual JSON error${detail ? ' (' + detail + ')' : ''}`,
        res.status);
    }
    if (!body || body.ok !== true || !Array.isArray(body.events)) throw new FeedError('bad_response', 'CSF response was not { ok: true, events: [...] }', res.status);
    const f = body.filters || {};
    if (f.state || f.type || f.from || f.to || f.updated_since || (f.offset != null && Number(f.offset) !== offset)) {
      throw new FeedError('unexpected_filters', `CSF applied filters we didn't ask for: ${JSON.stringify(f).slice(0, 200)}`, res.status);
    }
    return body;
  }
}

// → { ok: true, events, pages, total } or throws FeedError.
async function fetchFeed({ key, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), budgetMs = 20000 } = {}) {
  const deadline = Date.now() + budgetMs;
  for (let round = 0; round < 2; round++) {
    const byId = new Map();
    let offset = 0, total = null, pages = 0, changed = false;
    while (true) {
      if (pages >= MAX_PAGES) throw new FeedError('too_many_pages', `More than ${MAX_PAGES} pages`);
      const body = await fetchPage(offset, { key, fetchImpl, sleep, deadline });
      pages++;
      if (total == null) total = body.total;
      else if (body.total !== total) { changed = true; break; }
      for (const e of body.events) if (e && e.id != null) byId.set(String(e.id), pickEvent(e));
      if (body.next_offset == null) break;
      const next = Number(body.next_offset);
      if (!Number.isInteger(next) || next <= offset) throw new FeedError('bad_response', 'next_offset did not move forward');
      offset = next;
    }
    // Pages fetched while the feed changed underneath can skip an event: start over once.
    if (!changed && Number.isInteger(total) && byId.size !== total) changed = true;
    if (!changed) return { ok: true, events: [...byId.values()], pages, total };
  }
  throw new FeedError('feed_changed', 'The feed changed twice while it was being read; nothing was changed');
}

async function finishRun(db, id, patch) {
  if (!id) return;
  const { error } = await db.from('external_sync_runs').update({ finished_at: new Date().toISOString(), ...patch }).eq('id', id);
  if (error) console.warn('[csf] run log update failed:', error.message);
}

async function runSync(db, { trigger = 'schedule', key = process.env.CSF_API_KEY, fetchImpl = fetch, sleep, budgetMs = 20000,
                             emailBudgetMs = 4000, loopsFetch = fetch } = {}) {
  if (String(process.env.CSF_SYNC_ENABLED || '').toLowerCase() === 'false') return { skipped: 'disabled' };
  const started = Date.now();
  const { data: run, error: runErr } = await db.from('external_sync_runs').insert({ source: 'csf', trigger }).select('id').single();
  if (runErr) throw new Error(`external_sync_runs: ${runErr.message}`);
  const runId = run.id;
  if (!key) {
    await finishRun(db, runId, { ok: false, error: 'CSF_API_KEY is not set' });
    return { ok: false, run_id: runId, error: 'missing_key' };
  }

  let feed;
  try {
    feed = await fetchFeed({ key, fetchImpl, sleep, budgetMs });
  } catch (e) {
    const code = e instanceof FeedError ? e.code : 'error';
    const msg = e instanceof FeedError ? e.message : 'Sync failed before the feed was read';
    await finishRun(db, runId, { ok: false, http_status: e.httpStatus ?? null, error: msg });
    console.warn(`[csf] fetch failed: ${code}`);
    return { ok: false, run_id: runId, error: code, message: msg };
  }

  const { data: res, error } = await db.rpc('csf_sync_apply', { p_events: feed.events, p_show_types: SHOW_TYPES, p_run_id: runId });
  if (error || res?.error) {
    const msg = `csf_sync_apply: ${error?.message || res.error}`;
    await finishRun(db, runId, { ok: false, http_status: 200, pages: feed.pages, events_received: feed.events.length, error: msg.slice(0, 500) });
    return { ok: false, run_id: runId, error: 'apply_failed', message: msg };
  }

  let emails = null;
  try { emails = await sendShowFeedNotices(db, { budgetMs: emailBudgetMs, fetchImpl: loopsFetch }); }
  catch (e) { emails = { error: e.message }; console.warn('[csf] emails:', e.message); }
  await finishRun(db, runId, { ok: true, http_status: 200, pages: feed.pages, emails_sent: emails?.emailed ?? null });
  const out = { ok: true, run_id: runId, pages: feed.pages, total: feed.total, ms: Date.now() - started, ...res, emails };
  console.log('[csf] sync', JSON.stringify({ ...out, by_type: res.by_type }));
  return out;
}

// ── Emails for removed shows (reuse the "Hold - Dealer" / "Hold - Buyer" Loops emails) ──
function compose(n) {
  const p = n.payload || {};
  const show = p.show_name || 'A show';
  const where = [p.show_date, [p.show_city, p.show_state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const cards = p.cards || [];
  const cardList = cards.map(c => `${c.stock_code ? c.stock_code + ' · ' : ''}${c.title || 'Card'}`).join('\n');
  const credit = n.source_url ? `\n\nShow details via The Card Shop Finder: ${n.source_url}` : '';
  if (n.to === 'dealer') {
    const extra = (p.holds || p.offers)
      ? ` Buyers with a hold or offer on ${p.holds + p.offers === 1 ? 'one of them' : 'them'} have been told their hold is still in place and that you'll offer another show or shipping.`
      : '';
    return { templateEnv: 'LOOPS_HOLD_DEALER_ID', vars: {
      cardList, buyerName: '', buyerContact: '', buyerNote: '', holdEnds: '',
      headline: `${show} is no longer listed`,
      message: `The Card Shop Finder no longer lists ${show}${where ? ` (${where})` : ''}, so it may be cancelled. `
        + `You'd picked it for pickup on ${cards.length === 1 ? 'this listing' : `these ${cards.length} listings`}. CardShow removed that pickup option; `
        + `shipping is unchanged. Pick another show (Edit Card → Marketplace) or switch to shipping.${extra}${credit}`,
      actionUrl: `${SITE()}/app`, actionLabel: 'Open CardShow' } };
  }
  const dealer = p.dealer || 'The dealer';
  const title = cards.length > 1 ? `${cards[0].title} and ${cards.length - 1} more` : (cards[0]?.title || 'your card');
  return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: {
    cardList,
    headline: `${show} is no longer listed`,
    message: `You planned to pick up ${title} from ${dealer} at ${show}${where ? ` (${where})` : ''}. The Card Shop Finder no longer lists it, `
      + `so it may be cancelled. Your hold or offer is still in place, and ${dealer} will offer another show or shipping.${credit}`,
    actionUrl: `${SITE()}/account`, actionLabel: 'See your holds and offers' } };
}

async function sendShowFeedNotices(db, { fetchImpl = fetch, budgetMs = 5000, now = () => Date.now() } = {}) {
  const started = now();
  const out = { due: 0, emailed: 0, skipped: 0, failed: 0, waiting: 0 };
  const { data: due, error } = await db.rpc('show_feed_notices_due', { p_limit: 100 });
  if (error) throw new Error(`show_feed_notices_due: ${error.message}`);
  const key = process.env.LOOPS_API_KEY;
  for (const n of due || []) {
    if (now() - started > budgetMs) break;
    out.due++;
    if (!n.email) { await db.rpc('show_feed_notice_sent', { p_id: n.id }); out.skipped++; continue; }
    const mail = compose(n);
    const tid = process.env[mail.templateEnv];
    if (!key || !tid) { out.waiting++; continue; }
    try {
      const r = await fetchImpl('https://app.loops.so/api/v1/transactional', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionalId: tid, email: n.email, dataVariables: mail.vars }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) { out.failed++; continue; }
    } catch { out.failed++; continue; }
    await db.rpc('show_feed_notice_sent', { p_id: n.id });
    out.emailed++;
  }
  return out;
}

module.exports = { runSync, fetchFeed, sendShowFeedNotices, compose, pickEvent, SHOW_TYPES, FeedError, API };
