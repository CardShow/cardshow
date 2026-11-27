// Seller MCP server (netlify/functions/mcp-seller.js), Phase 1.
// Part A: HTTP/auth behaviour with stubs. Part B: walkthrough against the real database: a small adapter plays
// PostgREST (verifies the fake JWT, runs mcp_pre_request(), calls the mcp_* function as role authenticated).
//
//   cd tests/show-mode && KEEP_DB=1 ./mcp-seller.test.sh && node mcp-seller.test.mjs     (as the postgres user)
// Without the database (Part A only): SKIP_DB=1 node mcp-seller.test.mjs
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
const require = createRequire(import.meta.url);
process.env.MCP_SELLER_ENABLED = 'true';
process.env.SUPABASE_URL = 'https://proj.supabase.co';
const S = require('../../netlify/functions/mcp-seller.js')._test;
const PRM = require('../../netlify/functions/oauth-protected-resource.js');
const { isAssistantToken, refuseOAuthClient } = require('../../netlify/lib/oauth-guard.js');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } };

const A = 'aaaaaaaa-0000-0000-0000-000000000001', B = 'bbbbbbbb-0000-0000-0000-000000000002';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated', ...payload })}.sig-not-checked-here`;
const TOKEN_A = jwt({ sub: A, client_id: 'claude-client' });
const TOKEN_B = jwt({ sub: B, client_id: 'claude-client' });
const ev = (token, body, extra = {}) => ({ httpMethod: 'POST', headers: { host: 'getcardshow.com', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: JSON.stringify(body) });
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const parse = r => JSON.parse(r.body);

// Service-key stub: rate limits + log.
function svcStub(opts = {}) {
  const s = { inserts: [], updates: [], hits: 0 };
  s.rpc = async (name, args) => { s.hits++; return { data: { allowed: !(opts.blockAfter != null && s.hits > opts.blockAfter), reset_at: new Date(Date.now() + 30000).toISOString() } }; };
  s.from = (t) => ({
    insert: async (rows) => { s.inserts.push({ t, rows }); return { error: null }; },
    update: (v) => ({ eq: () => ({ eq: async () => { s.updates.push({ t, v }); return { error: null }; } }) }),
  });
  return s;
}

// ── Part A ──────────────────────────────────────────────────────────────────
{
  const r = await S.handle(ev(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), { dataFor: () => null, svc: null });
  const h = r.headers['WWW-Authenticate'] || '';
  ok('A01 no token: 401 with resource_metadata', r.statusCode === 401 && h.includes('resource_metadata="https://getcardshow.com/.well-known/oauth-protected-resource/mcp/seller"'));
  const app = await S.handle(ev(jwt({ sub: A }), { jsonrpc: '2.0', id: 1, method: 'tools/list' }), { dataFor: () => null, svc: null });
  ok('A02 normal app session token refused (OAuth only)', app.statusCode === 401 && /invalid_token/.test(app.headers['WWW-Authenticate']));
  const exp = await S.handle(ev(jwt({ sub: A, client_id: 'c', exp: 1000 }), { jsonrpc: '2.0', id: 1, method: 'tools/list' }), { dataFor: () => null, svc: null });
  ok('A03 expired token: 401 invalid_token', exp.statusCode === 401);
  const off = process.env.MCP_SELLER_ENABLED; process.env.MCP_SELLER_ENABLED = 'false';
  ok('A04 switched off: 404', (await S.handle(ev(TOKEN_A, {}), {})).statusCode === 404);
  process.env.MCP_SELLER_ENABLED = off;

  const prm = await PRM.handler({ headers: { host: 'deploy-preview-9--card-show.netlify.app' } });
  const pj = JSON.parse(prm.body);
  ok('A05 protected-resource metadata names Supabase as authorization server',
    pj.resource === 'https://deploy-preview-9--card-show.netlify.app/mcp/seller' && pj.authorization_servers[0] === 'https://proj.supabase.co/auth/v1' && !pj.scopes_supported);

  // disconnected / not approved → 401 so the client re-authorizes
  const discon = { rpc: async () => ({ data: null, error: { message: 'mcp:not_connected', code: '42501' } }) };
  const d = await S.handle(ev(TOKEN_A, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), { dataFor: () => discon, svc: null });
  ok('A06 disconnected assistant: 401 asking to reconnect', d.statusCode === 401 && /reconnect/i.test(parse(d).error.message));
  const notSeller = { rpc: async () => ({ data: null, error: { message: 'mcp:not_a_seller' } }) };
  const ns = await S.handle(ev(TOKEN_A, { jsonrpc: '2.0', id: 7, method: 'tools/list' }), { dataFor: () => notSeller, svc: null });
  ok('A07 non-dealer account: 403 with a clear message', ns.statusCode === 403 && /dealer account/i.test(parse(ns).error.message));

  // tools/list contains the 7 Phase 1 tools, all read-only, no internal fields
  const fake = { rpc: async (n) => n === 'mcp_session' ? { data: { user_id: A, client_id: 'claude-client', client_name: 'Claude', scopes: ['inventory:read'] } } : { data: { total: 0, results: [] } } };
  const tl = parse(await S.handle(ev(TOKEN_A, { jsonrpc: '2.0', id: 2, method: 'tools/list' }), { dataFor: () => fake, svc: svcStub() }));
  const names = tl.result.tools.map(t => t.name).sort().join(',');
  const readTools = tl.result.tools.filter(t => t.annotations.readOnlyHint).map(t => t.name).sort().join(',');
  ok('A08 eight read-only tools (plus the Phase 2 and 3 write tools), no internal fields',
    readTools === 'get_my_card,get_price_suggestion,list_my_inventory,list_my_shows,list_offers,sales_summary,stale_inventory,whoami'
     && tl.result.tools.length === 18 && tl.result.tools.every(t => !t.rpc && !('scope' in t) && !('write' in t)));

  // scope missing (server-side check), bad input, rate limit, log has no token
  const noRead = { rpc: async (n) => n === 'mcp_session' ? { data: { user_id: A, client_id: 'x', scopes: [] } } : { data: {} } };
  const sm = parse(await S.handle(ev(TOKEN_A, call(3, 'list_my_inventory')), { dataFor: () => noRead, svc: svcStub() }));
  ok('A09 missing scope: tool error telling the dealer to reconnect', sm.result.isError && /reconnect CardShow and approve "inventory:read"/.test(sm.result.content[0].text));
  const bi = parse(await S.handle(ev(TOKEN_A, call(4, 'get_my_card', { inventory_id: 'nope' })), { dataFor: () => fake, svc: svcStub() }));
  ok('A10 bad card id: clear tool error', bi.result.isError && /uuid/.test(bi.result.content[0].text));
  const rl = parse(await S.handle(ev(TOKEN_A, call(5, 'list_my_inventory')), { dataFor: () => fake, svc: svcStub({ blockAfter: 0 }) }));
  ok('A11 read rate limit', rl.result.isError && /Too many requests/.test(rl.result.content[0].text));
  const svc = svcStub();
  await S.handle(ev(TOKEN_A, call(6, 'list_my_inventory', { text: 'charizard', access_token: TOKEN_A })), { dataFor: () => fake, svc });
  const logged = JSON.stringify(svc.inserts);
  ok('A12 call logged as dealer_agent read, without any token', svc.inserts[0]?.rows[0]?.actor_type === 'dealer_agent'
     && svc.inserts[0].rows[0].status === 'read' && !logged.includes(TOKEN_A.split('.')[1]) && !/access_token/.test(logged));
  ok('A13 last-used time updated', svc.updates.some(u => u.t === 'mcp_client_grants' && u.v.last_used_at));
  ok('A14 sanitize drops secrets and long blobs',
    JSON.stringify(S.sanitize({ authorization: 'x', nested: { apiKey: 'y', img: 'a'.repeat(5000) } })).length < 200);

  // oauth guard on the other functions
  let reached = false;
  const guarded = refuseOAuthClient(async () => { reached = true; return { statusCode: 200 }; });
  const g1 = await guarded({ headers: { authorization: `Bearer ${TOKEN_A}` } });
  ok('A15 other functions refuse assistant tokens', g1.statusCode === 403 && !reached);
  await guarded({ headers: { authorization: `Bearer ${jwt({ sub: A })}` } });
  ok('A16 …and still accept the app\'s own sessions', reached && !isAssistantToken({ headers: {} }));

  // public /mcp server untouched: tool list identical to before (no auth needed)
  process.env.MARKETPLACE_MCP_ENABLED = 'true';
  const PUB = require('../../netlify/functions/mcp.js')._test;
  const pub = await PUB.handle({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) },
    { data: { rpc: async () => ({ data: {} }) }, svc: null });
  ok('A17 public /mcp still answers without a token, same 4 tools',
    pub.statusCode === 200 && JSON.parse(pub.body).result.tools.map(t => t.name).join(',') === 'search_cards,get_listing,list_upcoming_shows,get_show_inventory');
}

// ── Part B: real database ───────────────────────────────────────────────────
if (process.env.SKIP_DB) {
  console.log('(Part B skipped)');
} else {
  const DB = process.env.DB || 'cs_mcp_seller';
  const lit = v => {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return `'{${v.map(x => String(x).replace(/[{},"\\']/g, '')).join(',')}}'::uuid[]`;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'object') return `$j$${JSON.stringify(v)}$j$::jsonb`;
    return `$s$${v}$s$`;
  };
  const psql = sql => execFileSync('psql', ['-qAt', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const asUserSql = (claims, path) => `set session authorization authenticator; set role authenticated;
    select set_config('request.jwt.claim.sub', '${claims.sub || ''}', false), set_config('request.jwt.claims', $c$${JSON.stringify(claims)}$c$, false),
           set_config('request.path', '${path}', false) \\g /dev/null
    `;
  // Plays PostgREST for one token: verify (fake) signature, run the pre-request hook, call the function.
  const dataFor = token => ({
    rpc: async (name, args = {}) => {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      if (!token.endsWith('.sig-not-checked-here')) return { data: null, error: { code: 'PGRST301', message: 'JWSInvalidSignature' } };
      if (!/^[a-z_]+$/.test(name)) throw new Error('bad name');
      const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
      try {
        const out = execFileSync('psql', ['-qAt', '-v', 'ON_ERROR_STOP=1', '-d', DB], {
          input: `${asUserSql(claims, '/rpc/' + name)}select public.mcp_pre_request() \\g /dev/null\nselect public.${name}(${named})::text;\n`,
          encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        return { data: JSON.parse(out.trim().split('\n').pop()), error: null };
      } catch (e) {
        const m = /ERROR:\s+(.*)/.exec(String(e.stderr || e.message));
        return { data: null, error: { message: m ? m[1] : 'error' } };
      }
    },
  });
  // A connects Claude with read access (normal app session, as on the consent page).
  psql(`set session authorization authenticator; set role authenticated;
        select set_config('request.jwt.claim.sub', '${A}', false), set_config('request.jwt.claims', '{"sub":"${A}"}', false);
        select assistant_grant_consent('claude-client', 'Claude', array['inventory:read']);`);
  const run = async (token, msg, svc = svcStub()) => { const r = await S.handle(ev(token, msg), { dataFor, svc }); return { r, j: r.body ? JSON.parse(r.body) : null, svc }; };
  const tool = async (token, name, args) => (await run(token, call(1, name, args))).j.result;

  const init = await run(TOKEN_A, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai' } } });
  ok('B01 initialize after OAuth sign-in', init.j.result.serverInfo.name === 'cardshow-seller');
  const who = await tool(TOKEN_A, 'whoami');
  ok('B02 whoami: dealer_a, Claude, read scope', who.structuredContent.handle === 'dealer_a' && who.structuredContent.assistant === 'Claude');
  const inv = (await tool(TOKEN_A, 'list_my_inventory', {})).structuredContent;
  ok('B03 list inventory: 3 unsold cards, all A\'s', inv.total === 3 && inv.results.every(c => !c.id.startsWith('b')));
  const zard = inv.results.find(c => c.stock_code === 'S-1');
  ok('B04 money in cents + dollars, Card Hedge comp', zard.price_cents === 18000 && zard.price === '$180.00' && zard.comp.value === '$200.00' && zard.comp.source === 'Card Hedge');
  const sugg = (await tool(TOKEN_A, 'get_price_suggestion', { inventory_ids: inv.results.map(c => c.id), target_pct_of_comp: 0.95 })).structuredContent.results;
  ok('B05 price suggestions: $190 for Charizard, "No comp yet" for the others',
    sugg.find(s => s.inventory_id === zard.id).suggested_price === '$190.00' && sugg.filter(s => s.note === 'No comp yet').length === 2);
  const card = (await tool(TOKEN_A, 'get_my_card', { inventory_id: zard.id })).structuredContent;
  ok('B06 get_my_card with GTCR status and shows', card.gtcr.status === 'not_checked' && card.shows.length === 4);
  const shows = (await tool(TOKEN_A, 'list_my_shows', { when: 'past' })).structuredContent.shows;
  ok('B07 past shows', shows.map(s => s.id).sort().join(',') === 's_p1,s_p2,s_p3');
  const sum = (await tool(TOKEN_A, 'sales_summary', { show_id: 's_up' })).structuredContent;
  ok('B08 sales summary', sum.total === '$380.00' && sum.sales_count === 1);
  const stale = (await tool(TOKEN_A, 'stale_inventory', {})).structuredContent;
  ok('B09 stale inventory', stale.total === 1 && stale.results[0].stock_code === 'S-1');

  // isolation: B's token, B's data only; A's card ids give nothing
  const bInv = (await tool(TOKEN_B, 'list_my_inventory', { status: 'all' })).structuredContent;
  ok('B10 dealer B sees only B\'s card', bInv.total === 1 && bInv.results[0].id.startsWith('b'));
  ok('B11 dealer B can\'t open A\'s card', (await tool(TOKEN_B, 'get_my_card', { inventory_id: zard.id })).structuredContent.error === 'not_found');
  const bSugg = (await tool(TOKEN_B, 'get_price_suggestion', { inventory_ids: [zard.id] })).structuredContent.results[0];
  ok('B12 dealer B gets no values for A\'s card', bSugg.error === 'not_found' && !('comp' in bSugg));
  const bSum = (await tool(TOKEN_B, 'sales_summary', { show_id: 's_up' })).structuredContent;
  ok('B13 dealer B sees none of A\'s sales', bSum.sales_count === 0);

  // forged / foreign tokens
  const forged = `${TOKEN_A.split('.').slice(0, 2).join('.')}.forged`;
  const fr = await run(forged, call(1, 'list_my_inventory'));
  ok('B14 bad signature: 401', fr.r.statusCode === 401);
  const other = jwt({ sub: A, client_id: 'some-other-app' });
  const or = await run(other, call(1, 'list_my_inventory'));
  ok('B15 an assistant the dealer never approved: 401', or.r.statusCode === 401);

  // PriceCharting never appears; responses carry no internal ids beyond the card
  const all = JSON.stringify([inv, sugg, card, sum, stale]);
  ok('B16 no PriceCharting data in any response', !/pricecharting|sportscardspro|price_cache/i.test(all));

  // disconnect → next call 401
  psql(`set session authorization authenticator; set role authenticated;
        select set_config('request.jwt.claim.sub', '${A}', false), set_config('request.jwt.claims', '{"sub":"${A}"}', false);
        select assistant_revoke_client('claude-client');`);
  const after = await run(TOKEN_A, call(1, 'list_my_inventory'));
  ok('B17 after Disconnect the token stops working (401)', after.r.statusCode === 401);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
