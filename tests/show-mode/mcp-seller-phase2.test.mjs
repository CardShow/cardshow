// Seller MCP Phase 2: write tools through the real server code against the real Phase 2 test database.
//   cd tests/show-mode && KEEP_DB=1 ./mcp-seller-phase2.test.sh && node mcp-seller-phase2.test.mjs
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
const require = createRequire(import.meta.url);
process.env.MCP_SELLER_ENABLED = 'true';
process.env.SUPABASE_URL = 'https://proj.supabase.co';
const S = require('../../netlify/functions/mcp-seller.js')._test;
const DB = process.env.DB || 'cs_mcp_seller2';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } };
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ZARD = 'a0000000-0000-0000-0000-000000000001', DAN = 'a0000000-0000-0000-0000-000000000002';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = p => `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated', ...p })}.sig-not-checked-here`;
const TOKEN = jwt({ sub: A, client_id: 'walk-client' });
const READER = jwt({ sub: A, client_id: 'read-only' });

const sql = q => execFileSync('psql', ['-qAt', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const lit = v => v === null || v === undefined ? 'null' : typeof v === 'object' ? `$j$${JSON.stringify(v)}$j$::jsonb` : typeof v === 'number' ? String(v) : `$s$${v}$s$`;
const dataFor = token => ({
  rpc: async (name, args = {}) => {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const named = Object.entries(args).map(([k, v]) => `${k} => ${k === 'p_client_request_id' && v ? `${lit(v)}::uuid` : lit(v)}`).join(', ');
    try {
      const out = execFileSync('psql', ['-qAt', '-v', 'ON_ERROR_STOP=1', '-d', DB], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        input: `set session authorization authenticator; set role authenticated;
select set_config('request.jwt.claim.sub', '${claims.sub}', false), set_config('request.jwt.claims', $c$${JSON.stringify(claims)}$c$, false), set_config('request.path', '/rpc/${name}', false) \\g /dev/null
select public.mcp_pre_request() \\g /dev/null
select public.${name}(${named})::text;\n` });
      return { data: JSON.parse(out.trim().split('\n').pop()), error: null };
    } catch (e) {
      const m = /ERROR:\s+(.*)/.exec(String(e.stderr || e.message));
      return { data: null, error: { message: m ? m[1] : 'error' } };
    }
  },
});
function svcStub(opts = {}) {
  const s = { inserts: [], hits: 0 };
  s.rpc = async (name, a) => { s.hits++; const w = /:w:/.test(a.p_key); return { data: { allowed: !(w && opts.blockWrites), reset_at: new Date().toISOString() } }; };
  s.from = t => ({ insert: async rows => { s.inserts.push(...rows); return { error: null }; }, update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) });
  return s;
}
const gtcrCalls = [];
let gtcrAnswer = { checked: true, flagged: false, status: 'clear' };
const call = async (token, name, args, svc = svcStub()) => {
  const r = await S.handle({ httpMethod: 'POST', headers: { host: 'getcardshow.com', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) },
    { dataFor, svc, gtcrCheck: async (id, owner) => { gtcrCalls.push([id, owner]); return gtcrAnswer; } });
  const j = JSON.parse(r.body);
  return { res: j.result, out: j.result?.structuredContent, text: j.result?.content?.[0]?.text, svc };
};

// a fresh assistant with every scope
sql(`set session authorization authenticator; set role authenticated;
  select set_config('request.jwt.claim.sub', '${A}', false), set_config('request.jwt.claims', '{"sub":"${A}"}', false);
  select assistant_grant_consent('walk-client', 'Claude', array['inventory:read','inventory:write','sales:write']);`);

// set_price: preview, apply, reuse refused
const startPrice = sql(`select price from inventory where id = '${ZARD}'`);
let r = await call(TOKEN, 'set_price', { inventory_id: ZARD, price_cents: 21000 });
ok('01 preview: nothing changes, token returned', r.out.status === 'preview' && r.out.preview.new_price === '$210.00'
   && sql(`select price from inventory where id = '${ZARD}'`) === startPrice && /^[0-9a-f]{64}$/.test(r.out.confirm_token));
ok('02 preview logged as previewed, without the token', r.svc.inserts[0]?.status === 'previewed' && r.svc.inserts[0].action === 'write'
   && !JSON.stringify(r.svc.inserts).includes(r.out.confirm_token));
const tok = r.out.confirm_token;
r = await call(TOKEN, 'set_price', { inventory_id: ZARD, price_cents: 21000, confirm_token: tok });
ok('03 confirmed: applied exactly as previewed', r.out.status === 'done' && Number(sql(`select price from inventory where id = '${ZARD}'`)) === 210
   && r.svc.inserts[0]?.status === 'applied' && r.svc.inserts[0].applied_at);
r = await call(TOKEN, 'set_price', { inventory_id: ZARD, price_cents: 21000, confirm_token: tok });
ok('04 same token again: refused, asks for a new preview', r.res.isError && r.out.reason === 'token_used' && /preview it again/i.test(r.out.message));
r = await call(TOKEN, 'set_price', { inventory_id: ZARD, price_cents: 22000, confirm_token: 'f'.repeat(64) });
ok('05 made-up token refused', r.res.isError && r.out.reason === 'invalid_token');

// update_card with cert change → GTCR check
r = await call(TOKEN, 'update_card', { inventory_id: ZARD, cert_number: '99887766' });
ok('06 cert change preview says a GTCR check will run', r.out.preview.gtcr_recheck === true);
r = await call(TOKEN, 'update_card', { inventory_id: ZARD, cert_number: '99887766', confirm_token: r.out.confirm_token });
ok('07 applied, GTCR check ran for this dealer’s card and is reported', r.out.status === 'done' && r.out.gtcr?.status === 'clear'
   && gtcrCalls.at(-1)?.[0] === ZARD && gtcrCalls.at(-1)?.[1] === A);
gtcrAnswer = { checked: true, flagged: true, status: 'report_on_file' };
r = await call(TOKEN, 'update_card', { inventory_id: ZARD, cert_number: '11223344' });
r = await call(TOKEN, 'update_card', { inventory_id: ZARD, cert_number: '11223344', confirm_token: r.out.confirm_token });
ok('08 a stolen/lost report is explained to the dealer', r.out.gtcr?.flagged && /stolen or lost/.test(r.out.gtcr.message));
gtcrAnswer = { checked: true, flagged: false, status: 'clear' };

// record_sale: ambiguous description, then by id three times
r = await call(TOKEN, 'record_sale', { description: 'prizm', sale_price_cents: 1000, payment_method: 'cash', client_request_id: '33333333-2222-3333-4444-555555555555' });
ok('09 description matching several cards → candidates, no preview', r.out.status === 'needs_choice' && r.out.candidates.length >= 2 && !r.res.isError);
const REQ = '44444444-2222-3333-4444-555555555555';
const saleArgs = { inventory_id: DAN, sale_price_cents: 2500, payment_method: 'zelle', client_request_id: REQ };
r = await call(TOKEN, 'record_sale', saleArgs);
ok('10 sale preview: card, price, payment, off-show, last copy', r.out.preview.sale_price === '$25.00' && r.out.preview.payment_method === 'Zelle'
   && r.out.preview.last_copy === true && r.out.preview.show === null);
const confirm = { ...saleArgs, confirm_token: r.out.confirm_token };
const r1 = await call(TOKEN, 'record_sale', confirm), r2 = await call(TOKEN, 'record_sale', confirm), r3 = await call(TOKEN, 'record_sale', confirm);
ok('11 the same record_sale sent 3 times: one sale, the same answer', r1.out.status === 'done' && r2.out.status === 'already_done' && r3.out.status === 'already_done'
   && r1.out.sale_id === r3.out.sale_id && sql(`select count(*) from sales where client_sale_id = '${REQ}'`) === '1'
   && sql(`select status from inventory where id = '${DAN}'`) === 'Sold');
ok('12 only the first is logged with the request id', r1.svc.inserts[0]?.client_request_id === REQ && r2.svc.inserts[0]?.client_request_id === null);
r = await call(TOKEN, 'record_sale', { inventory_id: ZARD, sale_price_cents: 100, payment_method: 'cash' });
ok('13 missing client_request_id explained', r.res.isError && /client_request_id/.test(r.out.message));

// scope, rate limit, read-only assistant
sql(`set session authorization authenticator; set role authenticated;
  select set_config('request.jwt.claim.sub', '${A}', false), set_config('request.jwt.claims', '{"sub":"${A}"}', false);
  select assistant_grant_consent('read-only', 'Reader', array['inventory:read']);`);
r = await call(READER, 'set_price', { inventory_id: ZARD, price_cents: 100 });
ok('14 assistant without write access: told to reconnect and approve', r.res.isError && /approve "inventory:write"/.test(r.text));
r = await call(TOKEN, 'set_price', { inventory_id: ZARD, price_cents: 100 }, svcStub({ blockWrites: true }));
ok('15 write rate limit', r.res.isError && /Too many changes/.test(r.text));
const listed = (await S.handle({ httpMethod: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, { dataFor, svc: svcStub() }));
const tools = JSON.parse(listed.body).result.tools;
ok('16 write tools listed as non-read-only, record_sale idempotent, every one explains the two steps',
   tools.filter(t => !t.annotations.readOnlyHint).map(t => t.name).sort().join(',') === 'publish_to_show,record_sale,set_price,unpublish_from_show,update_card'
   && tools.find(t => t.name === 'record_sale').annotations.idempotentHint === true
   && tools.filter(t => !t.annotations.readOnlyHint).every(t => /clear yes/.test(t.description)));

// GTCR agent_check
process.env.SUPABASE_SERVICE_KEY = 'svc-test-key';
process.env.GTCR_READ_API_KEY = 'gtcr-key';
const G = require('../../netlify/functions/gtcr-trust-check.js');
const row = { id: ZARD, seller_id: A, trust_flag: null, cert_number: '123', grader: 'PSA' };
const writes = [];
const fakeDb = { from: t => ({
  select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row }) }) }),
  insert: async v => { writes.push([t, v]); return { error: null }; },
  update: v => ({ eq: async () => { writes.push([t, v]); return { error: null }; } }),
  delete: () => ({ eq: async () => { writes.push([t, 'delete']); return { error: null }; } }) }) };
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ card_status: 'REPORTED_STOLEN' }), text: async () => '{"card_status":"REPORTED_STOLEN"}' });
const bad = await G._test.handleAgentCheck(fakeDb, { headers: { 'x-cardshow-agent': 'nope' } }, { inventory_id: ZARD, owner_id: A });
ok('17 agent_check refuses a wrong header', bad.statusCode === 401);
const other = await G._test.handleAgentCheck(fakeDb, { headers: { 'x-cardshow-agent': G._test.agentToken() } }, { inventory_id: ZARD, owner_id: 'someone-else' });
ok('18 agent_check refuses another dealer’s card', other.statusCode === 404);
const good = JSON.parse((await G._test.handleAgentCheck(fakeDb, { headers: { 'x-cardshow-agent': G._test.agentToken() } }, { inventory_id: ZARD, owner_id: A })).body);
ok('19 agent_check logs the check, flags and unpublishes on a stolen report', good.success && good.matched && good.trust_flag === 'flagged'
   && writes.some(([t, v]) => t === 'cert_trust_checks' && v.trigger === 'agent') && writes.some(([t, v]) => t === 'show_inventory' && v === 'delete'));
const mineHash = require('crypto').createHash('sha256').update('mcp-seller-gtcr:svc-test-key').digest('hex');
ok('20 the seller server and the GTCR function agree on the header', mineHash === G._test.agentToken());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
