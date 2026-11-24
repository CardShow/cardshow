// The Card Shop Finder sync (netlify/lib/csf-events.js, netlify/functions/csf-feed-admin.js) with the CSF API stubbed.
// node tests/show-mode/csf-sync.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runSync, compose, sendShowFeedNotices, SHOW_TYPES, API } = require('../../netlify/lib/csf-events.js');
const admin = require('../../netlify/functions/csf-feed-admin.js');

const KEY = 'csf_' + 'ab12'.repeat(12);
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('PASS ', label); } else { fail++; console.log('FAIL ', label); } };

// Every console line, to check the key never shows up.
const logged = [];
for (const k of ['log', 'warn', 'error']) { const orig = console[k]; console[k] = (...a) => { logged.push(a.map(String).join(' ')); if (k !== 'log' || String(a[0]).startsWith('PASS') || String(a[0]).startsWith('FAIL')) orig(...a); }; }

// The example event from CSF's docs (plus a field we must drop).
const docEvent = { id: 1234, name: 'Dallas Card Show', type: 'card_show', date_start: '2026-11-14', date_end: '2026-11-15',
  time_start: '09:00', time_end: '17:00', venue: 'Example Convention Center', address: '100 Main St', city: 'Dallas', state: 'TX',
  postal_code: '75201', lat: 32.7767, lng: -96.797, admission_price: 10, featured: false, updated_at: '2026-10-20T15:04:05Z',
  url: 'https://thecardshopfinder.com/event/dallas-card-show-nov-2026/?utm_source=yourapp&utm_medium=partner_feed&utm_campaign=events',
  description: 'never stored' };
const ev = (id, extra = {}) => ({ ...docEvent, id, name: 'Show ' + id, lat: null, lng: null, time_start: null, time_end: null,
  admission_price: null, url: `https://thecardshopfinder.com/event/e${id}/`, ...extra });
const page = (events, { total = events.length, next = null, offset = 0, filters = {} } = {}) =>
  ({ ok: true, count: events.length, total, next_offset: next,
     filters: { state: null, type: null, from: null, to: null, updated_since: null, limit: 1000, offset, ...filters }, events });

// A CSF stub: a list of responses, in order. Records every request.
function csf(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, headers: opts?.headers || {} });
    const r = responses.shift();
    if (!r) throw new Error('no more stub responses');
    const status = r.status || 200;
    return { status, ok: status >= 200 && status < 300, headers: { get: k => (r.headers || {})[k.toLowerCase()] ?? null },
             json: async () => (r.body === undefined ? page([]) : r.body) };
  };
  fn.calls = calls;
  return fn;
}

// A fake database: records run rows, rpc calls and notice sends.
function fakeDb({ apply = { received: 0 }, notices = [] } = {}) {
  const db = { runs: [], rpcs: [], sent: [] };
  db.from = table => ({
    insert: row => ({ select: () => ({ single: async () => { const r = { id: 'run' + (db.runs.length + 1), ...row }; db.runs.push(r); return { data: { id: r.id } }; } }) }),
    update: patch => ({ eq: async (_c, id) => { Object.assign(db.runs.find(r => r.id === id), patch); return { error: null }; } }),
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: db.admin ? { id: 'p' } : null }) }) }),
  });
  db.rpc = async (name, args) => {
    db.rpcs.push({ name, args });
    if (name === 'csf_sync_apply') return { data: typeof apply === 'function' ? apply(args) : apply, error: null };
    if (name === 'show_feed_notices_due') return { data: notices, error: null };
    if (name === 'show_feed_notice_sent') { db.sent.push(args.p_id); return { data: null, error: null }; }
    return { data: null, error: { message: 'unknown rpc ' + name } };
  };
  db.auth = { getUser: async t => (t === 'good' ? { data: { user: { id: 'p' } } } : { data: null, error: { message: 'bad' } }) };
  return db;
}
const applyOf = db => db.rpcs.find(r => r.name === 'csf_sync_apply');
const noSleep = async () => {};

// 1. One page, the docs' example.
{
  const db = fakeDb({ apply: { received: 1, shows_created: 1, by_type: { card_show: 1 } } });
  const f = csf([{ body: page([docEvent]) }]);
  const out = await runSync(db, { key: KEY, fetchImpl: f, sleep: noSleep });
  ok('docs example: one request, run recorded ok', out.ok && f.calls.length === 1 && db.runs[0].ok === true && db.runs[0].pages === 1);
  ok('key only in the X-API-Key header', f.calls[0].headers['X-API-Key'] === KEY && !f.calls[0].url.includes(KEY) && !/[?&]key=/.test(f.calls[0].url));
  ok('asks for the whole feed', f.calls[0].url === `${API}?limit=1000&offset=0`);
  const ap = applyOf(db).args;
  ok('apply gets the event without extra fields, url as sent', ap.p_events.length === 1 && !('description' in ap.p_events[0])
     && ap.p_events[0].url === docEvent.url && ap.p_run_id === 'run1');
  ok('show types: card_show, sports, convention', JSON.stringify(ap.p_show_types) === JSON.stringify(['card_show', 'sports', 'convention'])
     && SHOW_TYPES.length === 3);
}
// 2. Two pages.
{
  const db = fakeDb();
  const f = csf([{ body: page([ev(1), ev(2)], { total: 3, next: 2 }) }, { body: page([ev(3)], { total: 3, offset: 2 }) }]);
  const out = await runSync(db, { key: KEY, fetchImpl: f, sleep: noSleep });
  ok('two pages fetched and merged', out.ok && f.calls.length === 2 && f.calls[1].url.endsWith('offset=2') && applyOf(db).args.p_events.length === 3);
}
// 3. Total changes between pages: start over once; twice: fail, nothing applied.
{
  const db = fakeDb();
  const f = csf([{ body: page([ev(1)], { total: 2, next: 1 }) }, { body: page([ev(2)], { total: 3, offset: 1 }) },
                 { body: page([ev(1), ev(2)], { total: 2 }) }]);
  const out = await runSync(db, { key: KEY, fetchImpl: f, sleep: noSleep });
  ok('total changed once: started over, then fine', out.ok && f.calls.length === 3 && applyOf(db).args.p_events.length === 2);
  const db2 = fakeDb();
  const f2 = csf([{ body: page([ev(1)], { total: 2, next: 1 }) }, { body: page([ev(2)], { total: 3, offset: 1 }) },
                  { body: page([ev(1)], { total: 2, next: 1 }) }, { body: page([ev(2)], { total: 4, offset: 1 }) }]);
  const out2 = await runSync(db2, { key: KEY, fetchImpl: f2, sleep: noSleep });
  ok('total changed twice: failed run, nothing applied', !out2.ok && out2.error === 'feed_changed' && !applyOf(db2) && db2.runs[0].ok === false);
  const db3 = fakeDb();
  const out3 = await runSync(db3, { key: KEY, fetchImpl: csf([{ body: page([ev(1)], { total: 5 }) }, { body: page([ev(1)], { total: 5 }) }]), sleep: noSleep });
  ok('fewer events than total: treated as incomplete', !out3.ok && !applyOf(db3));
}
// 4. Errors: 401, 429, 400, 500, bad filters. Nothing applied, run says why.
{
  const db = fakeDb();
  const out = await runSync(db, { key: KEY, fetchImpl: csf([{ status: 401, body: { ok: false, error: 'Invalid key' } }]), sleep: noSleep });
  ok('401: key rejected, not retried', !out.ok && out.error === 'key_rejected' && db.runs[0].http_status === 401
     && /key rejected/.test(db.runs[0].error) && !applyOf(db));
  let slept = 0;
  const db2 = fakeDb();
  const out2 = await runSync(db2, { key: KEY, fetchImpl: csf([{ status: 429, headers: { 'retry-after': '3' } }, { body: page([ev(1)]) }]),
                                   sleep: async ms => { slept += ms; } });
  ok('429 with a short Retry-After: waits once, then fine', out2.ok && slept === 3000);
  const db3 = fakeDb(); slept = 0;
  const out3 = await runSync(db3, { key: KEY, fetchImpl: csf([{ status: 429, headers: { 'retry-after': '3600' } }]), sleep: async ms => { slept += ms; } });
  ok('429 with a long wait: no wait, failed run for the next schedule', !out3.ok && out3.error === 'rate_limited' && slept === 0
     && db3.runs[0].http_status === 429 && !applyOf(db3));
  for (const st of [400, 500]) {
    const d = fakeDb();
    const o = await runSync(d, { key: KEY, fetchImpl: csf([{ status: st, body: { ok: false, error: 'bad limit' } }]), sleep: noSleep });
    ok(`${st}: failed run, nothing applied`, !o.ok && d.runs[0].http_status === st && !applyOf(d));
  }
  const d4 = fakeDb();
  const o4 = await runSync(d4, { key: KEY, fetchImpl: csf([{ body: page([ev(1)], { filters: { state: 'TX' } }) }]), sleep: noSleep });
  ok('filters we didn\'t ask for: failed, nothing applied', !o4.ok && o4.error === 'unexpected_filters' && !applyOf(d4));
  const d5 = fakeDb();
  const o5 = await runSync(d5, { key: KEY, fetchImpl: csf([{ body: { ok: false } }]), sleep: noSleep });
  ok('ok:false body: failed', !o5.ok && o5.error === 'bad_response');
  const d6 = fakeDb();
  const o6 = await runSync(d6, { key: KEY, fetchImpl: async () => { throw new Error('ECONNRESET ' + API); }, sleep: noSleep });
  ok('network error: failed run', !o6.ok && o6.error === 'network');
}
// 5. Switch, missing key, apply error.
{
  process.env.CSF_SYNC_ENABLED = 'false';
  const db = fakeDb();
  const out = await runSync(db, { key: KEY, fetchImpl: csf([]) });
  ok('CSF_SYNC_ENABLED=false: skipped, no run row', out.skipped === 'disabled' && db.runs.length === 0);
  delete process.env.CSF_SYNC_ENABLED;
  const db2 = fakeDb();
  const out2 = await runSync(db2, { key: '', fetchImpl: csf([]) });
  ok('no key: run says so', !out2.ok && db2.runs[0].error === 'CSF_API_KEY is not set');
  const db3 = fakeDb({ apply: () => ({ error: 'bad_events' }) });
  const out3 = await runSync(db3, { key: KEY, fetchImpl: csf([{ body: page([ev(1)]) }]), sleep: noSleep });
  ok('apply error: failed run', !out3.ok && out3.error === 'apply_failed' && db3.runs[0].ok === false);
}
// 6. Emails.
{
  const dealer = { id: 'n1', to: 'dealer', email: 'a@x.test', source_url: 'https://thecardshopfinder.com/event/e1/?utm_source=cardshow',
    payload: { show_name: 'Dallas Card Show', show_date: 'Nov 14-15, 2026', show_city: 'Dallas', show_state: 'TX',
               cards: [{ title: 'Charizard PSA 10', stock_code: 'S-1' }, { title: 'Daniels PSA 9' }], holds: 1, offers: 1 } };
  const buyer = { id: 'n2', to: 'buyer', email: 'c@x.test', source_url: dealer.source_url,
    payload: { show_name: 'Dallas Card Show', show_date: 'Nov 14-15, 2026', cards: [{ title: 'Charizard PSA 10' }], dealer: 'Dealer A' } };
  const d = compose(dealer), b = compose(buyer);
  ok('dealer email: show, both cards, pickup removed, credit with the exact url', d.templateEnv === 'LOOPS_HOLD_DEALER_ID'
     && d.vars.headline === 'Dallas Card Show is no longer listed' && d.vars.cardList === 'S-1 · Charizard PSA 10\nDaniels PSA 9'
     && /removed that pickup option/.test(d.vars.message) && d.vars.message.includes('via The Card Shop Finder: ' + dealer.source_url)
     && /Buyers with a hold or offer/.test(d.vars.message));
  ok('buyer email: hold still in place, dealer named', b.templateEnv === 'LOOPS_HOLD_BUYER_ID' && /hold or offer is still in place/.test(b.vars.message)
     && /from Dealer A/.test(b.vars.message) && b.vars.actionUrl.endsWith('/account'));
  process.env.LOOPS_API_KEY = 'k'; process.env.LOOPS_HOLD_DEALER_ID = 'd'; process.env.LOOPS_HOLD_BUYER_ID = 'b';
  const db = fakeDb({ notices: [dealer, buyer, { id: 'n3', to: 'buyer', email: null, payload: {} }] });
  const sent = [];
  const out = await sendShowFeedNotices(db, { fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body)); return { ok: true }; } });
  ok('emails sent and marked; no email address = skipped', out.emailed === 2 && out.skipped === 1 && db.sent.length === 3
     && sent[0].transactionalId === 'd' && sent[1].email === 'c@x.test');
  delete process.env.LOOPS_HOLD_BUYER_ID;
  const db2 = fakeDb({ notices: [buyer] });
  const out2 = await sendShowFeedNotices(db2, { fetchImpl: async () => ({ ok: true }) });
  ok('without the Loops id: kept for later', out2.waiting === 1 && db2.sent.length === 0);
  const db3 = fakeDb({ notices: [dealer] });
  const out3 = await sendShowFeedNotices(db3, { fetchImpl: async () => ({ ok: false }) });
  ok('Loops error: not marked, retried later', out3.failed === 1 && db3.sent.length === 0);
}
// 7. The admin function.
{
  ok('admin: POST only', (await admin.handle({ httpMethod: 'GET' }, { db: fakeDb() })).statusCode === 405);
  ok('admin: not the platform owner → 403', (await admin.handle({ httpMethod: 'POST', headers: { authorization: 'Bearer bad' }, body: '{"action":"run"}' },
     { db: fakeDb() })).statusCode === 403);
  const db = fakeDb(); db.admin = true;
  const r = await admin.handle({ httpMethod: 'POST', headers: { authorization: 'Bearer good' }, body: '{"action":"run"}' },
    { db, syncOpts: { key: KEY, fetchImpl: csf([{ body: page([ev(1)]) }]), sleep: noSleep } });
  ok('admin: run now, recorded as manual', r.statusCode === 200 && JSON.parse(r.body).ok && db.runs[0].trigger === 'manual');
  ok('admin: bad action', (await admin.handle({ httpMethod: 'POST', body: '{"action":"x"}' }, { db, skipAuth: true })).statusCode === 400);
}

ok('the key never appears in any log line', !logged.some(l => l.includes(KEY)));
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
