// Seller MCP Phase 3: set_prices, add_cards_from_photos, list_offers / respond_to_offer through the real server code
// against the Phase 3 test database, plus the photo reader (mcp-photo-job-background.js) with fakes.
//   cd tests/show-mode && KEEP_DB=1 ./mcp-seller-phase3.test.sh && node mcp-seller-phase3.test.mjs
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
const require = createRequire(import.meta.url);
process.env.MCP_SELLER_ENABLED = 'true';
process.env.SUPABASE_URL = 'https://proj.supabase.co';
const S = require('../../netlify/functions/mcp-seller.js')._test;
const W = require('../../netlify/functions/mcp-photo-job-background.js')._test;
const DB = process.env.DB || 'cs_mcp_seller3';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } };
const A = 'aaaaaaaa-0000-0000-0000-000000000001', C = 'cccccccc-0000-0000-0000-000000000003';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = p => `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated', ...p })}.sig`;
const TOKEN = jwt({ sub: A, client_id: 'walk3' });
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
function svcStub() {
  const s = { inserts: [] };
  s.rpc = async () => ({ data: { allowed: true } });
  s.from = () => ({ insert: async rows => { s.inserts.push(...rows); return { error: null }; }, update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) });
  return s;
}
const uploads = [], kicks = [], notified = [], gtcrCalls = [];
const deps = svc => ({ dataFor, svc,
  uploadPhoto: async (key, buf, type) => { uploads.push({ key, size: buf.length, type }); return true; },
  kickPhotoJob: async id => { kicks.push(id); return true; },
  notifyOffer: async id => { notified.push(id); },
  gtcrCheck: async (id, owner) => { gtcrCalls.push([id, owner]); return { checked: true, flagged: false, status: 'clear' }; } });
const call = async (token, name, args) => {
  const svc = svcStub();
  const r = await S.handle({ httpMethod: 'POST', headers: { host: 'getcardshow.com', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }, deps(svc));
  const j = JSON.parse(r.body);
  return { res: j.result, out: j.result?.structuredContent, text: j.result?.content?.[0]?.text, svc };
};
const asDealer = q => sql(`set session authorization authenticator; set role authenticated;
  select set_config('request.jwt.claim.sub', '${A}', false), set_config('request.jwt.claims', '{"sub":"${A}"}', false); ${q}`);
asDealer(`select assistant_grant_consent('walk3', 'Claude', array['inventory:read','inventory:write','sales:write','offers:write']);`);

// ── tools/list ──
const listed = JSON.parse((await S.handle({ httpMethod: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, deps(svcStub()))).body).result.tools;
ok('01 Phase 3 tools listed; writes explain the two steps', ['set_prices', 'add_cards_from_photos', 'respond_to_offer', 'list_offers']
  .every(n => listed.some(t => t.name === n)) && listed.find(t => t.name === 'list_offers').annotations.readOnlyHint === true
  && ['set_prices', 'add_cards_from_photos', 'respond_to_offer'].every(n => /clear yes/.test(listed.find(t => t.name === n).description)));

// ── set_prices ──
sql(`insert into inventory (id, seller_id, card_title, player, price, status, pricing_card_id, pricing_match_status, comp_value_cents) values
  ('a3000000-0000-0000-0000-000000000001', '${A}', 'Bulk one', 'One', 50, 'Available', 'ch-1', 'manual', 6000),
  ('a3000000-0000-0000-0000-000000000002', '${A}', 'Bulk two', 'Two', 80, 'Available', 'ch-2', 'manual', 10000)`);
const bulk = { inventory_ids: ['a3000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002'],
  rule: { type: 'pct_of_comp', percent: 95 }, client_request_id: '55555555-0000-0000-0000-000000000001' };
let r = await call(TOKEN, 'set_prices', bulk);
ok('02 set_prices preview: every change and the totals, nothing changed', r.out.status === 'preview' && r.out.preview.count === 2
  && r.out.preview.total_before === '$130.00' && r.out.preview.total_after === '$152.00'
  && sql(`select price from inventory where id = 'a3000000-0000-0000-0000-000000000001'`) === '50');
r = await call(TOKEN, 'set_prices', { ...bulk, confirm_token: r.out.confirm_token });
ok('03 confirmed: both prices changed, logged as applied with the request id', r.out.status === 'done' && r.out.updated === 2
  && sql(`select string_agg(price::int::text, ',' order by id) from inventory where id::text like 'a3000000%'`) === '57,95'
  && r.svc.inserts[0]?.status === 'applied' && r.svc.inserts[0].client_request_id === bulk.client_request_id
  && r.svc.inserts[0].target_ids.length === 2);
r = await call(TOKEN, 'set_prices', { ...bulk, client_request_id: undefined });
ok('04 missing client_request_id explained', r.res.isError && /client_request_id/.test(r.out.message));

// ── photos: start ──
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
r = await call(TOKEN, 'add_cards_from_photos', { images: [{ base64: jpeg.toString('base64'), media_type: 'image/jpeg' }, { url: 'https://img.example.com/card.jpg' }] });
const job = r.out?.job_id;
ok('05 photos sent: a background job, the upload stored in the dealer\'s folder, the reader started, nothing added',
  r.out.status === 'working' && r.out.photos === 2 && uploads.length === 1 && uploads[0].key.startsWith(`${A}/`) && uploads[0].type === 'image/jpeg'
  && kicks.at(-1) === job && sql(`select count(*) from inventory where seller_id = '${A}' and created_at > now() - interval '1 minute' and card_title like 'Photo%'`) === '0');
ok('06 the photo itself is never logged', !JSON.stringify(r.svc.inserts).includes(jpeg.toString('base64')));
r = await call(TOKEN, 'add_cards_from_photos', { images: [{ base64: Buffer.from('not an image').toString('base64') }] });
ok('07 a non-image refused', r.res.isError && /JPEG, PNG or WebP/.test(r.text));
const REQ = '55555555-0000-0000-0000-000000000002';
r = await call(TOKEN, 'add_cards_from_photos', { job_id: job, client_request_id: REQ });
ok('08 checking back while photos are read: still working', r.out.status === 'working' && r.out.read === 0);

// ── the reader (fakes for storage, scan-card and the network) ──
const jobRow = JSON.parse(sql(`select row_to_json(j) from mcp_photo_jobs j where id = '${job}'`));
function fakeDb(row) {
  const st = { row: { ...row }, captures: [], stored: {}, downloads: [] };
  st.storage = { from: () => ({
    download: async key => { st.downloads.push(key); return { data: new Blob([jpeg]), error: null }; },
    upload: async (key, buf) => { st.stored[key] = buf.length; return { error: null }; } }) };
  st.from = table => {
    const q = { _upd: null, update(v) { this._upd = v; return this; }, eq() { return this; }, or() { return this; }, select() { return this; },
      async maybeSingle() { Object.assign(st.row, this._upd); return { data: st.row }; },
      then(res) { if (this._upd) Object.assign(st.row, this._upd); return Promise.resolve({ error: null }).then(res); },
      upsert: async rows => { st.captures.push(rows); return { error: null }; } };
    return q;
  };
  return st;
}
const fdb = fakeDb(jobRow);
const scan = async ev => ({ body: JSON.stringify({ success: true, card: JSON.parse(ev.body).media_type && {
  player_name: 'Paul Skenes', year: '2024', set_name: 'Topps Chrome', card_number: 'USC1', grading_company: 'PSA', grade: '10',
  cert_number: '81234567', autograph: false, confidence: { player_name: 0.95, year: 0.9, set_name: 0.6, grade: 0.95, cert_number: 0.9 } } }) });
const fetchImpl = async () => new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
const out = await W.runJob(fdb, job, { scan, fetchImpl, checkUrl: async u => new URL(u) });
ok('09 reader: both photos read, the link photo saved to the dealer\'s folder, a capture row per photo owned by the dealer',
  out.done === 2 && fdb.row.status === 'done' && fdb.row.images.every(i => i.status === 'done')
  && Object.keys(fdb.stored).length === 1 && Object.keys(fdb.stored)[0].startsWith(`${A}/`)
  && fdb.captures.length === 2 && fdb.captures.every(c => c.seller_id === A && c.entry_point === 'case_scan'));
// copy the reader's result into the real database, as the service role would
sql(`insert into card_captures (id, seller_id, entry_point, original_key, uploaded_at)
  select (e->>'capture_id')::uuid, '${A}', 'case_scan', e->>'key', now() from jsonb_array_elements($j$${JSON.stringify(fdb.row.images)}$j$::jsonb) e;
  update mcp_photo_jobs set status = 'done', images = $j$${JSON.stringify(fdb.row.images)}$j$::jsonb, updated_at = now() where id = '${job}'`);
r = await call(TOKEN, 'add_cards_from_photos', { job_id: job, client_request_id: REQ });
ok('10 preview: the drafts, with the set name the scan was unsure of flagged',
  r.out.status === 'preview' && r.out.preview.count >= 1 && r.out.preview.cards[0].check_fields.includes('set'));
const fix = { job_id: job, client_request_id: REQ, show_id: 'none',
  cards: [{ index: 1, set: 'Topps Chrome Update', price_cents: 45000 }, { index: 2, include: false }] };
r = await call(TOKEN, 'add_cards_from_photos', fix);
ok('11 the dealer\'s fix clears the flag; a photo can be left out', r.out.preview.count === 1 && r.out.preview.need_a_check === 0
  && r.out.preview.cards[0].price === '$450.00' && !r.out.preview.show);
const gBefore = gtcrCalls.length;
r = await call(TOKEN, 'add_cards_from_photos', { ...fix, confirm_token: r.out.confirm_token });
ok('12 confirmed: the card is added with its photo, a GTCR check runs for the slab', r.out.status === 'done' && r.out.added === 1
  && sql(`select count(*) from inventory where seller_id = '${A}' and player = 'Paul Skenes' and card_set = 'Topps Chrome Update' and price = 450 and primary_capture_id is not null`) === '1'
  && gtcrCalls.length === gBefore + 1 && r.out.gtcr?.checked === 1);
r = await call(TOKEN, 'add_cards_from_photos', { ...fix, confirm_token: 'a'.repeat(64) });
ok('13 the same request again: already done, nothing added', r.out.status === 'already_done'
  && sql(`select count(*) from inventory where player = 'Paul Skenes'`) === '1');

// ── reader safety ──
ok('14 private and local addresses refused', W.privateIp('10.0.0.5') && W.privateIp('192.168.1.1') && W.privateIp('127.0.0.1')
  && W.privateIp('169.254.169.254') && W.privateIp('::1') && W.privateIp('::ffff:10.1.2.3') && !W.privateIp('8.8.8.8'));
let refused = 0;
for (const u of ['http://img.example.com/a.jpg', 'https://localhost/a.jpg', 'https://127.0.0.1/a.jpg', 'https://user:pw@example.com/a.jpg']) {
  try { await W.checkUrl(u); } catch { refused++; }
}
ok('15 non-https, local and credentialed links refused', refused === 4);
let redirectedTo = null;
try {
  await W.fetchPhoto('https://img.example.com/a.jpg', async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/x.jpg' } }),
    async u => { redirectedTo = u; if (/127\.0\.0\.1/.test(u)) throw new Error('That address is not public'); return new URL(u); });
} catch (e) { redirectedTo = e.message; }
ok('16 a redirect to a private address is refused', redirectedTo === 'That address is not public');
let big = null;
try { await W.fetchPhoto('https://img.example.com/a.jpg', async () => new Response(Buffer.alloc(4 * 1024 * 1024), { status: 200 }), async u => new URL(u)); }
catch (e) { big = e.message; }
ok('17 a photo over 3.5 MB is refused while reading', /3\.5 MB/.test(big || ''));
const bad = await require('../../netlify/functions/mcp-photo-job-background.js')._test.handle({ httpMethod: 'POST', headers: {}, body: '{}' });
process.env.SUPABASE_SERVICE_KEY = 'svc-key';
const bad2 = await W.handle({ httpMethod: 'POST', headers: { 'x-cardshow-photo-job': 'nope' }, body: '{}' });
ok('18 the reader only answers the MCP server', bad.statusCode === 404 && bad2.statusCode === 403);

// ── offers ──
sql(`insert into inventory (id, seller_id, card_title, player, price, status) values ('a3000000-0000-0000-0000-000000000009', '${A}', 'Offer two', 'Two Guy', 200, 'Available');
  update inventory set listing_status = 'active', accepts_offers = true where id = 'a3000000-0000-0000-0000-000000000009';
  insert into offers (id, listing_id, listing_ids, dealer_id, buyer_id, buyer_name, buyer_contact, amount_cents, offer_cents, asking_cents, last_by, history, expires_at, status)
  values ('0f300000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000009', array['a3000000-0000-0000-0000-000000000009'::uuid], '${A}', '${C}',
          'Robin', 'robin@example.test', 15000, 15000, 20000, 'buyer', '[]', now() + interval '1 day', 'pending')`);
r = await call(TOKEN, 'list_offers', {});
ok('19 list_offers: the offer to answer, buyer contact left out', r.out.results.some(o => o.offer_id === '0f300000-0000-0000-0000-000000000001' && o.offer === '$150.00')
  && !r.text.includes('robin@example'));
r = await call(TOKEN, 'respond_to_offer', { offer_id: '0f300000-0000-0000-0000-000000000001', action: 'decline' });
ok('20 respond preview: what happens, nothing sent', r.out.status === 'preview' && /Robin gets an email/.test(r.out.preview.what_happens) && notified.length === 0);
r = await call(TOKEN, 'respond_to_offer', { offer_id: '0f300000-0000-0000-0000-000000000001', action: 'decline', confirm_token: r.out.confirm_token });
ok('21 confirmed: declined through respond_offer and the buyer\'s email sent at once', r.out.status === 'done' && r.out.offer_status === 'declined'
  && sql(`select status from offers where id = '0f300000-0000-0000-0000-000000000001'`) === 'declined'
  && notified.at(-1) === '0f300000-0000-0000-0000-000000000001');
asDealer(`select assistant_grant_consent('read-only', 'Reader', array['inventory:read']);`);
r = await call(READER, 'respond_to_offer', { offer_id: '0f300000-0000-0000-0000-000000000001', action: 'decline' });
ok('22 assistant without offers:write: told to reconnect and approve', r.res.isError && /approve "offers:write"/.test(r.text));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
