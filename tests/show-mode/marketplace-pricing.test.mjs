// Marketplace Phase 1: netlify/lib/card-values.js (pricing job), netlify/functions/mcp.js (read-only MCP)
// and saved-search-alerts.js, with Card Hedge, Loops and Supabase stubbed.   node marketplace-pricing.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const CV = require('../../netlify/lib/card-values.js');
const MCP = require('../../netlify/functions/mcp.js')._test;
const { runAlerts } = require('../../netlify/functions/saved-search-alerts.js');

let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };

// ── pure helpers ──
check('normalizeGrade', CV.normalizeGrade('psa 10.0') === 'PSA 10' && CV.normalizeGrade('BGS 9.50') === 'BGS 9.5'
  && CV.normalizeGrade('Ungraded') === 'Raw' && CV.normalizeGrade('Raw') === 'Raw' && CV.normalizeGrade('Arena Club 9') === 'ARENA CLUB 9'
  && CV.normalizeGrade('') === null);
const vals = CV.pricesToValues([{ grade: 'PSA 10', price: '470.0' }, { grade: 'psa 10', price: '1' }, { grade: 'Raw', price: 12.5 },
  { grade: 'BGS 9.5', price: 0 }, { grade: 'CGC 10', price: '$1,200.00', sales_count: 4 }]);
check('pricesToValues: cents, one row per grade, zero dropped',
  JSON.stringify(vals.map(v => [v.grade, v.value_cents])) === JSON.stringify([['PSA 10', 47000], ['Raw', 1250], ['CGC 10', 120000]])
  && vals[2].sales_30d === 4);
check('buildMatchQuery leaves the grade out', CV.buildMatchQuery({ year: 2024, set: 'Prizm', player: 'Jayden Daniels', number: '#331', parallel: 'Silver', grade_key: 'PSA 10' })
  === '2024 Prizm Jayden Daniels #331 Silver');

// ── fake Supabase (service) for runRefresh ──
function fakeDb(work) {
  const state = { work, rpc: [], usage: { calls: 0 }, alerts: 0 };
  return {
    state,
    rpc: async (name, args) => {
      state.rpc.push([name, args]);
      if (name === 'pricing_claim_work') { const w = state.work; state.work = { match: [], refresh: [] }; return { data: w }; }
      if (name === 'pricing_bump_usage') { state.usage.calls += args.p_calls; return { data: { calls: state.usage.calls } }; }
      if (name === 'pricing_mark_alert') { state.alerts += 1; return { data: state.alerts === 1 }; }
      return { data: { ok: true } };
    },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { calls: state.usage.calls } }) }) }) }) }),
  };
}
let chCalls = [];
const cardHedge = (responder) => async (url, opts) => {
  const q = JSON.parse(opts.body).query; chCalls.push(q);
  const r = responder(q);
  if (r.status && r.status !== 200) return new Response('x', { status: r.status });
  return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
};
process.env.CARDHEDGE_API_KEY = 'k';
process.env.CARDHEDGE_DAILY_LIMIT = '100';
process.env.CARDHEDGE_PER_MINUTE = '100000';

let db = fakeDb({
  match: [
    { identity: 'zard', card: { player: 'Charizard', year: 1999, set: 'Base Set', number: '4', parallel: 'Holo' } },
    { identity: 'weak', card: { player: 'Someone', year: 2020, set: 'X' } },
  ],
  refresh: [{ card_id: 'ch-old', query: 'old card', on_demand: false }, { card_id: 'ch-hot', query: 'hot card', on_demand: true }],
});
chCalls = [];
let s = await CV.runRefresh(db, { fetchImpl: cardHedge(q => {
  if (q.includes('Charizard')) return { match: { card_id: 'ch-zard', confidence: 0.97, description: '1999 Pokemon Base Set Charizard #4 Holo', prices: [{ grade: 'PSA 10', price: '210' }, { grade: 'Raw', price: '50' }] } };
  if (q.includes('Someone')) return { match: { card_id: 'ch-x', confidence: 0.6, prices: [] } };
  if (q === 'hot card') return { match: { card_id: 'ch-hot', confidence: 0.99, prices: [{ grade: 'PSA 9', price: 90 }] } };
  if (q === 'old card') return { match: { card_id: 'ch-other', confidence: 0.99, prices: [{ grade: 'PSA 9', price: 90 }] } };
  return {};
}) });
check('on-demand refresh runs first', chCalls[0] === 'hot card', JSON.stringify(chCalls));
const rpcs = db.state.rpc.filter(([n]) => n !== 'pricing_bump_usage');
const rec = rpcs.filter(([n]) => n === 'pricing_record_match').map(([, a]) => [a.p_identity, a.p_status, a.p_card_id || null]);
check('confident match recorded; weak match → no_match', JSON.stringify(rec) === JSON.stringify([['zard', 'matched', 'ch-zard'], ['weak', 'no_match', null]]));

// Parallels: Card Hedge's card must name the parallel or the print run, or the match waits for a check.
{
  const S = { player: 'C.J. Stroud', year: 2024, set: 'Panini Select', number: '42', parallel: '17/49', title: '2024 Panini Select C.J. Stroud /49' };
  check('serial "17/49" sent to Card Hedge as the print run "/49"', CV.buildMatchQuery(S) === '2024 Panini Select C.J. Stroud #42 /49', CV.buildMatchQuery(S));
  check('numbered card matched to the base card → needs a check', CV.parallelCheck(S, '2024 Panini Select C.J. Stroud #42').ok === false
    && CV.parallelCheck(S, '2024 Panini Select C.J. Stroud #42').reason === 'parallel_unconfirmed');
  check('numbered card matched to a /49 card → ok', CV.parallelCheck(S, '2024 Panini Select CJ Stroud Gold #/49').ok);
  const C = { player: 'Dylan Crews', parallel: 'Fuchsia Refractor' };
  check('named parallel needs every distinctive word', !CV.parallelCheck(C, 'Dylan Crews Refractor').ok && CV.parallelCheck(C, 'Dylan Crews Fuchsia Refractor /299').ok);
  check('no parallel and no print run → ok; "Base" counts as none', CV.parallelCheck({ player: 'Joe Burrow', title: '2025 Topps Chrome Joe Burrow' }, 'Joe Burrow').ok
    && CV.parallelCheck({ parallel: 'Base' }, 'anything').ok);
  check('no matched title for a parallel → needs a check', !CV.parallelCheck(C, null).ok);
}
const applied = rpcs.filter(([n]) => n === 'pricing_apply_values').map(([, a]) => [a.p_card_id, a.p_error, (a.p_values || []).length]);
check('match call stores every grade at once (no 2nd call); a refresh that comes back as a different card keeps old values',
  JSON.stringify(applied) === JSON.stringify([['ch-hot', null, 1], ['ch-zard', null, 2], ['ch-old', 'card_changed', 0]]), JSON.stringify(applied));
check('one Card Hedge call per card', chCalls.length === 4 && s.calls === 4 && db.state.usage.calls === 4);

// daily limit: stops at 90%
db = fakeDb({ match: [], refresh: Array.from({ length: 30 }, (_, i) => ({ card_id: `c${i}`, query: `q${i}`, on_demand: false })) });
db.state.usage.calls = 85;  // limit 100 → stop at 90
chCalls = [];
s = await CV.runRefresh(db, { fetchImpl: cardHedge(q => ({ match: { card_id: q.replace('q', 'c'), confidence: 1, prices: [{ grade: 'Raw', price: 1 }] } })) });
check('stops at 90% of the daily limit', chCalls.length === 5 && s.stopped === 'daily_limit' && s.left_for_next_run === 25);
check('80% alert sent once (no email config → logged)', db.state.alerts === 1);

// 429 stops the run, 500 keeps value and continues
db = fakeDb({ match: [], refresh: [{ card_id: 'a', query: 'a', on_demand: false }, { card_id: 'b', query: 'b', on_demand: false }, { card_id: 'c', query: 'c', on_demand: false }] });
chCalls = [];
s = await CV.runRefresh(db, { fetchImpl: cardHedge(q => (q === 'a' ? { status: 500 } : q === 'b' ? { status: 429 } : { match: { card_id: 'c', confidence: 1, prices: [{ grade: 'Raw', price: 1 }] } })) });
const errs = db.state.rpc.filter(([n]) => n === 'pricing_apply_values').map(([, a]) => [a.p_card_id, a.p_error]);
check('500 → error stored (value kept); 429 → run stops', JSON.stringify(errs) === JSON.stringify([['a', 'cardhedge_http_500'], ['b', 'cardhedge_http_429']]) && s.stopped === 'rate_limited' && chCalls.length === 2);

// Retries with other wordings when the first finds nothing
{
  const crews = { player: 'Dylan Crews', year: 2024, set: 'Bowman Chrome Prospects', number: 'BCP-23', parallel: 'Fuchsia Refractor',
                  title: '2024 Bowman Chrome Dylan Crews Fuchsia Refractor' };
  const qs = CV.matchQueries(crews).map(q => q.query);
  check('wordings: full, number without dash, seller title, then base card', qs.length === 4 && qs[0].includes('#BCP-23') && qs[1].includes('#BCP23')
    && qs[2] === crews.title && !/Fuchsia/.test(qs[3]) && CV.matchQueries(crews)[3].baseOnly === true, JSON.stringify(qs));
  check('a plain card gets no extra wordings', CV.matchQueries({ player: 'Someone', year: 2020, set: 'X' }).length === 1);

  let mdb = fakeDb({ match: [{ identity: 'crews', card: crews }], refresh: [] });
  chCalls = [];
  let r = await CV.runRefresh(mdb, { fetchImpl: cardHedge(q => q.includes('BCP23')
    ? { match: { card_id: 'ch-crews', confidence: 0.95, description: '2024 Bowman Chrome Prospects Dylan Crews Fuchsia Refractor /299', prices: [{ grade: 'PSA 10', price: 300 }] } }
    : { match: { card_id: 'ch-wrong', confidence: 0.4, prices: [] } }) });
  let rm = mdb.state.rpc.filter(([n]) => n === 'pricing_record_match').map(([, a]) => a);
  check('second wording finds it → matched, with the query that worked', chCalls.length === 2 && rm.length === 1 && rm[0].p_status === 'matched'
    && rm[0].p_query.includes('#BCP23') && r.retried === 1 && mdb.state.usage.calls === 2, JSON.stringify(rm));

  mdb = fakeDb({ match: [{ identity: 'crews', card: crews }], refresh: [] });
  chCalls = [];
  await CV.runRefresh(mdb, { fetchImpl: cardHedge(q => /Fuchsia/.test(q)
    ? { match: { card_id: 'x', confidence: 0.3, prices: [] } }
    : { match: { card_id: 'ch-base', confidence: 0.96, description: '2024 Bowman Chrome Prospects Dylan Crews #BCP-23', prices: [{ grade: 'Raw', price: 12 }] } }) });
  rm = mdb.state.rpc.filter(([n]) => n === 'pricing_record_match').map(([, a]) => a);
  check('only the base card found → needs a check (base_value_only), values stored but hidden', chCalls.length === 4 && rm[0].p_status === 'review'
    && rm[0].p_reason === 'base_value_only' && mdb.state.rpc.some(([n, a]) => n === 'pricing_apply_values' && a.p_card_id === 'ch-base'), JSON.stringify(rm));

  mdb = fakeDb({ match: [{ identity: 'crews', card: crews }], refresh: [] });
  chCalls = [];
  await CV.runRefresh(mdb, { fetchImpl: cardHedge(() => ({ match: { card_id: 'x', confidence: 0.2, prices: [] } })) });
  rm = mdb.state.rpc.filter(([n]) => n === 'pricing_record_match').map(([, a]) => a);
  check('nothing found in any wording → no_match once, 4 calls', chCalls.length === 4 && rm.length === 1 && rm[0].p_status === 'no_match');

  mdb = fakeDb({ match: [{ identity: 'crews', card: crews }], refresh: [] });
  chCalls = [];
  await CV.runRefresh(mdb, { fetchImpl: cardHedge(q => q.includes('BCP-23') && /Fuchsia/.test(q) ? { match: { card_id: 'x', confidence: 0.2 } } : { status: 500 }) });
  rm = mdb.state.rpc.filter(([n]) => n === 'pricing_record_match').map(([, a]) => a);
  check('an error on a retry stops the retries → error (tried again next run)', chCalls.length === 2 && rm[0].p_status === 'error');
}

// ── MCP ──
process.env.MARKETPLACE_MCP_ENABLED = 'true';
process.env.MARKETPLACE_SITE_URL = 'https://getcardshow.com';
const listing = { id: '11111111-1111-4111-8111-111111111111', url: '/c/11111111-1111-4111-8111-111111111111-charizard', title: 'Charizard PSA 10',
  price_cents: 18000, comp: { value_cents: 21000, low_cents: 19500, high_cents: 23000 }, pct_of_comp: 0.857, deal: true,
  dealer: { handle: 'dealer_a', url: '/d/dealer_a' }, show: { id: 'show_near', name: 'Near Show' } };
const dataCalls = [];
const data = { rpc: async (name, args) => {
  dataCalls.push([name, args]);
  if (name === 'search_listings') return { data: { total: 1, offset: 0, results: [listing] } };
  if (name === 'get_listing') return { data: args.p_id === listing.id ? listing : { error: 'not_found' } };
  if (name === 'list_upcoming_shows') return { data: [{ id: 'show_near', name: 'Near Show', url: '/show.html?id=show_near', listed_cards: 2 }] };
  if (name === 'request_card_value_refresh') return { data: { ok: true } };
  return { data: null };
} };
let limitHits = 0; const logs = [];
const svc = {
  rpc: async (name, args) => { limitHits++; return { data: { allowed: limitHits <= 10 || !args.p_key.startsWith('mcp:m:'), reset_at: new Date(Date.now() + 30000).toISOString() } }; },
  from: () => ({ insert: async rows => { logs.push(...rows); return { error: null }; } }),
};
const post = (body, headers = {}) => MCP.handle({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '1.2.3.4', 'user-agent': 'Claude-User/1.0', ...headers }, body: JSON.stringify(body) }, { data, svc });

let r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai', version: '1' }, capabilities: {} } });
let b = JSON.parse(r.body);
check('initialize → tools capability, server info', r.statusCode === 200 && b.result.protocolVersion === '2025-06-18' && b.result.capabilities.tools && b.result.serverInfo.name === 'cardshow');
r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
check('notification → 202, no body', r.statusCode === 202 && r.body === '');
r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
b = JSON.parse(r.body);
check('tools/list: the four read-only tools, nothing that buys/holds/offers',
  JSON.stringify(b.result.tools.map(t => t.name)) === JSON.stringify(['search_cards', 'get_listing', 'list_upcoming_shows', 'get_show_inventory'])
  && b.result.tools.every(t => t.annotations.readOnlyHint));
r = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_cards', arguments: { query: 'charizard psa 10', deals_only: true, limit: 500, foo: 'x' } } });
b = JSON.parse(r.body);
const sc = b.result.structuredContent;
check('search_cards → listings with absolute links tagged ?ref=agent-{client}',
  sc.results[0].url === 'https://getcardshow.com/c/11111111-1111-4111-8111-111111111111-charizard?ref=agent-claude-user'
  && sc.results[0].dealer.url === 'https://getcardshow.com/d/dealer_a?ref=agent-claude-user' && sc.results[0].price === '$180.00' && sc.results[0].comp.value === '$210.00');
const sp = dataCalls.find(([n]) => n === 'search_listings')[1].p;
check('search params mapped (q, filters, limit capped at 50, unknown args dropped)', sp.q === 'charizard psa 10' && sp.deals_only === true && sp.limit === 50 && !('foo' in sp));
check('text content mirrors structured content', JSON.parse(b.result.content[0].text).total === 1);
r = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_listing', arguments: { listing_id: 'nope' } } });
b = JSON.parse(r.body);
check('bad listing id → tool error, no DB call', b.result.isError === true && !dataCalls.some(([n, a]) => n === 'get_listing' && a.p_id === 'nope'));
r = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_listing', arguments: { listing_id: listing.id } } });
b = JSON.parse(r.body);
check('get_listing → listing + background value refresh request', b.result.structuredContent.id === listing.id && dataCalls.some(([n]) => n === 'request_card_value_refresh'));
r = await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_show_inventory', arguments: { show_id: 'show_near', query: 'zard' } } });
check('get_show_inventory scopes to the show', dataCalls.filter(([n]) => n === 'search_listings').pop()[1].p.show_id === 'show_near');
r = await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'reserve_listing', arguments: {} } });
check('unknown tool (e.g. reserve) refused', JSON.parse(r.body).error.code === -32602);
check('every tool call logged as external_agent with returned ids', logs.length === 4 && logs.every(l => l.actor_type === 'external_agent')
  && logs[0].tool === 'search_cards' && logs[0].target_ids[0] === listing.id, String(logs.length));
r = await post({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'list_upcoming_shows', arguments: {} } });
check('rate limit → 429 with Retry-After', r.statusCode === 429 && Number(r.headers['Retry-After']) > 0 && JSON.parse(r.body).error);
r = await post({ jsonrpc: '2.0', id: 9, method: 'nope' });
check('unknown method → -32601', JSON.parse(r.body).error.code === -32601);
r = await MCP.handle({ httpMethod: 'POST', headers: {}, body: '{bad' }, { data, svc });
check('bad JSON → parse error', r.statusCode === 400 && JSON.parse(r.body).error.code === -32700);
r = await MCP.handle({ httpMethod: 'GET', headers: {} }, { data, svc });
check('GET → 405 (no SSE stream)', r.statusCode === 405);
process.env.MARKETPLACE_MCP_ENABLED = 'false';
r = await post({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
check('switch off → 404', r.statusCode === 404);

// ── saved-search alerts ──
const sent = []; const marked = [];
const adb = { rpc: async (name, args) => {
  if (name === 'saved_searches_due') return { data: [
    { id: 's1', name: 'Zards', params: { q: 'charizard' }, last_checked_at: '2026-11-20T00:00:00Z', email: 'c@example.test' },
    { id: 's2', name: 'Nothing new', params: { q: 'zzz' }, last_checked_at: '2026-11-20T00:00:00Z', email: 'c@example.test' }] };
  if (name === 'search_listings') return { data: args.p.q === 'charizard' ? { total: 1, results: [listing] } : { total: 0, results: [] } };
  if (name === 'saved_search_checked') { marked.push([args.p_id, args.p_alerted]); return { data: null }; }
  return { data: null };
} };
let out = await runAlerts(adb, { fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body)); return new Response('{}', { status: 200 }); } });
check('no Loops settings → skipped, nothing marked', out.skipped === 'loops_not_configured' && marked.length === 0);
process.env.LOOPS_API_KEY = 'lk'; process.env.LOOPS_SAVED_SEARCH_ID = 'tid';
out = await runAlerts(adb, { fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body)); return new Response('{}', { status: 200 }); } });
check('new matches → one email; nothing new → no email; both marked checked',
  sent.length === 1 && sent[0].email === 'c@example.test' && sent[0].dataVariables.firstUrl.startsWith('https://getcardshow.com/c/')
  && JSON.stringify(marked) === JSON.stringify([['s1', true], ['s2', false]]));

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
