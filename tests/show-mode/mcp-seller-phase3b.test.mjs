// Seller MCP Phase 3b: add_cards + photo_upload_link through the real server code against the 3b test database,
// and photo-link.js (the link page's server) with an in-memory fake of Supabase.
//   cd tests/show-mode && KEEP_DB=1 ./mcp-seller-phase3b.test.sh && node mcp-seller-phase3b.test.mjs
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
const require = createRequire(import.meta.url);
process.env.MCP_SELLER_ENABLED = 'true';
process.env.SUPABASE_URL = 'https://proj.supabase.co';
const S = require('../../netlify/functions/mcp-seller.js')._test;
const L = require('../../netlify/functions/photo-link.js')._test;
const DB = process.env.DB || 'cs_mcp_seller3b';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } };
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = p => `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated', ...p })}.sig`;
const TOKEN = jwt({ sub: A, client_id: 'walk3b' });
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
function svcStub() {
  const s = { inserts: [] };
  s.rpc = async () => ({ data: { allowed: true } });
  s.from = () => ({ insert: async rows => { s.inserts.push(...rows); return { error: null }; }, update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) });
  return s;
}
const call = async (name, args) => {
  const svc = svcStub();
  const r = await S.handle({ httpMethod: 'POST', headers: { host: 'getcardshow.com', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) },
    { dataFor, svc, gtcrCheck: async () => ({ checked: true, flagged: false, status: 'clear' }), kickPhotoJob: async () => true });
  const j = JSON.parse(r.body);
  return { res: j.result, out: j.result?.structuredContent, text: j.result?.content?.[0]?.text, svc };
};
sql(`set session authorization authenticator; set role authenticated;
  select set_config('request.jwt.claim.sub', '${A}', false), set_config('request.jwt.claims', '{"sub":"${A}"}', false);
  select assistant_grant_consent('walk3b', 'Claude', array['inventory:read','inventory:write']);`);

// ── server: add_cards ──
const args = { client_request_id: '66666666-0000-0000-0000-000000000001', show_id: 'none',
  cards: [{ player: 'Jackson Holliday', year: '2022', set: 'Bowman Chrome', grader: 'PSA', grade: '10', cert_number: '90909090', unsure_fields: ['set'] }] };
let r = await call('add_cards', args);
ok('01 add_cards preview flags the unsure field; nothing added', r.out.status === 'preview' && r.out.preview.need_a_check === 1
  && /Ask the dealer/.test(r.out.preview.check_note) && sql(`select count(*) from inventory where player = 'Jackson Holliday'`) === '0');
r = await call('add_cards', { ...args, confirm_token: r.out.confirm_token });
const url = r.out.photo_link?.url || '';
ok('02 confirmed: added, the slab gets a GTCR check, and the dealer gets a photo link', r.out.status === 'done' && r.out.added === 1
  && r.out.gtcr?.checked === 1 && /^https:\/\/getcardshow\.com\/photo\/[A-Z2-9]{10}$/.test(url) && !('photo_link_code' in r.out));
ok('03 the link code is not in the activity log', !JSON.stringify(r.svc.inserts).includes(url.split('/').pop()));
r = await call('photo_upload_link', {});
ok('04 photo_upload_link: a link and a job id to check back with', r.out.status === 'link_ready' && /\/photo\/[A-Z2-9]{10}$/.test(r.out.url) && r.out.job_id);
const upJob = r.out.job_id;
r = await call('add_cards_from_photos', { job_id: upJob, client_request_id: '66666666-0000-0000-0000-000000000002' });
ok('05 before the dealer sends the photos: waiting_for_photos', r.out.status === 'waiting_for_photos');
const tools = JSON.parse((await S.handle({ httpMethod: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, { dataFor, svc: svcStub() })).body).result.tools;
ok('06 the server tells assistants to read chat photos themselves and use add_cards', tools.some(t => t.name === 'add_cards' && /photo the dealer shared/.test(t.description)));

// ── photo-link.js with a fake Supabase ──
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)]);
function fake() {
  const t = {
    mcp_photo_links: [
      { id: 'L1', code_hash: sha('ATTACHCODE'), owner_id: A, kind: 'attach', inventory_ids: ['c1', 'c2'], job_id: null, uploads: 0, expires_at: new Date(Date.now() + 9e5).toISOString() },
      { id: 'L2', code_hash: sha('SCANCODE22'), owner_id: A, kind: 'scan', inventory_ids: [], job_id: 'J1', uploads: 0, expires_at: new Date(Date.now() + 9e5).toISOString() },
      { id: 'L3', code_hash: sha('OLDCODE333'), owner_id: A, kind: 'attach', inventory_ids: ['c1'], job_id: null, uploads: 0, expires_at: new Date(Date.now() - 1000).toISOString() }],
    inventory: [{ id: 'c1', seller_id: A, card_title: 'Card one', stock_code: 'S-1', primary_capture_id: null },
                { id: 'c2', seller_id: A, card_title: 'Card two', stock_code: 'R-2', primary_capture_id: null },
                { id: 'x9', seller_id: 'other', card_title: 'Not yours', primary_capture_id: null }],
    mcp_photo_jobs: [{ id: 'J1', owner_id: A, status: 'collecting', images: [] }],
    card_captures: [],
  };
  const st = { t, stored: [], kicked: [] };
  st.rpc = async () => ({ data: { allowed: true } });
  st.storage = { from: () => ({ upload: async (k, b) => { st.stored.push(k); return { error: null }; } }) };
  st.from = name => {
    const f = []; let upd = null, single = false;
    const run = () => {
      let rows = t[name].filter(r => f.every(fn => fn(r)));
      if (upd) { rows.forEach(r => Object.assign(r, upd)); return { error: null }; }
      return single ? { data: rows[0] || null } : { data: rows };
    };
    const q = { select() { return q; }, eq(c, v) { f.push(r => r[c] === v); return q; }, in(c, v) { f.push(r => v.includes(r[c])); return q; },
      update(v) { upd = v; return q; }, maybeSingle() { single = true; return Promise.resolve(run()); },
      insert: async row => { t[name].push(row); return { error: null }; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); } };
    return q;
  };
  return st;
}
const post = (db, body) => L.handle({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '1.2.3.4' }, body: JSON.stringify(body) },
  { db, kickReader: async id => db.kicked.push(id) }).then(r => ({ status: r.statusCode, body: JSON.parse(r.body) }));
let db = fake();
let x = await post(db, { action: 'info', code: 'attachcode' });
ok('07 info: the link\'s cards (code is case-insensitive)', x.status === 200 && x.body.kind === 'attach' && x.body.cards.map(c => c.title).join() === 'Card one,Card two');
x = await post(db, { action: 'info', code: 'WRONGCODE1' });
ok('08 an unknown code: not found', x.status === 404);
x = await post(db, { action: 'upload', code: 'OLDCODE333', card_id: 'c1', image_base64: jpeg.toString('base64') });
ok('09 an expired link takes no photos', x.status === 410);
x = await post(db, { action: 'upload', code: 'ATTACHCODE', card_id: 'x9', image_base64: jpeg.toString('base64') });
ok('10 only the link\'s own cards', x.status === 404 && !db.stored.length);
x = await post(db, { action: 'upload', code: 'ATTACHCODE', card_id: 'c1', image_base64: Buffer.from('hello').toString('base64') });
ok('11 not an image: refused', x.status === 400 && x.body.error === 'not_an_image');
x = await post(db, { action: 'upload', code: 'ATTACHCODE', card_id: 'c1', image_base64: jpeg.toString('base64') });
const c1 = db.t.inventory.find(c => c.id === 'c1');
ok('12 photo attached: stored in the dealer\'s folder, a capture row, the card\'s photo set',
  x.status === 200 && db.stored[0]?.startsWith(`${A}/`) && db.t.card_captures[0]?.inventory_id === 'c1' && db.t.card_captures[0].seller_id === A
  && c1.primary_capture_id === db.t.card_captures[0].id && c1.image_source === 'seller');
x = await post(db, { action: 'done', code: 'SCANCODE22' });
ok('13 scan link: sending with no photos refused', x.status === 400 && x.body.error === 'no_photos');
await post(db, { action: 'upload', code: 'SCANCODE22', image_base64: jpeg.toString('base64') });
x = await post(db, { action: 'upload', code: 'SCANCODE22', image_base64: jpeg.toString('base64') });
const job = db.t.mcp_photo_jobs[0];
ok('14 scan uploads join the batch, waiting to be read', x.body.photos === 2 && job.images.length === 2 && job.images.every(i => i.status === 'waiting' && i.key.startsWith(`${A}/`)));
x = await post(db, { action: 'done', code: 'SCANCODE22' });
ok('15 "Send to Claude": the batch is read', x.status === 200 && job.status === 'working' && db.kicked[0] === 'J1');
x = await post(db, { action: 'upload', code: 'SCANCODE22', image_base64: jpeg.toString('base64') });
ok('16 no more photos once sent', x.status === 409);
db = fake(); db.rpc = async () => ({ data: { allowed: false } });
x = await post(db, { action: 'info', code: 'ATTACHCODE' });
ok('17 too many tries from one address: slowed down', x.status === 429);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
