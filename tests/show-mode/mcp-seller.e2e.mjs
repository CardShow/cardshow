// Seller MCP: the OAuth consent page (oauth-consent.html) and Profile → Connected assistants (js/connected-assistants.js).
//   node mcp-seller.e2e.mjs "iPhone 13"      (pages are served from disk through Playwright routing; no web server)
import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const ROOT = new URL('../../', import.meta.url).pathname;
const BASE = 'http://cardshow.test';
// Registered first, so the more specific routes added later win.
async function serveFromDisk(ctx) {
  await ctx.route(BASE + '/**', r => {
    let p = decodeURIComponent(new URL(r.request().url()).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) r.fulfill({ path: f });
    else r.fulfill({ status: 404, body: '' });
  });
}
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); };

// ── consent page, with a fake supabase-js that has the OAuth server methods ──
const fakeOAuth = `(() => {
  const st = window.__oa = JSON.parse(sessionStorage.getItem('__oa') || 'null') || {
    session: null, seller: { handle: 'tester', display_name: 'Tester' }, calls: [], consented: false, ourGrants: [], sbGrants: [] };
  const save = () => sessionStorage.setItem('__oa', JSON.stringify(st));
  const q = (table) => { const f = {}; const b = {
      select() { return b; }, eq(c, v) { f[c] = v; return b; }, maybeSingle() { return b; },
      then(res) { const rows = table === 'sellers' ? (st.seller ? [st.seller] : []) : st.ourGrants;
        return Promise.resolve({ data: table === 'sellers' ? rows[0] || null : rows, error: null }).then(res); } }; return b; };
  window.supabase = { createClient() { return {
    from: q,
    rpc: async (n, a) => { st.calls.push([n, a]); save(); return st.rpcError ? { data: null, error: { message: 'boom' } } : { data: { ok: true }, error: null }; },
    auth: {
      getSession: async () => ({ data: { session: st.session } }),
      signInWithPassword: async ({ email, password }) => {
        if (password !== 'right') return { data: {}, error: { message: 'Invalid login' } };
        st.session = { user: { id: 'u1', email } }; save(); return { data: { session: st.session }, error: null }; },
      signOut: async () => { st.session = null; save(); return {}; },
      oauth: {
        getAuthorizationDetails: async (id) => { st.calls.push(['details', id]); save();
          if (id === 'bad') return { data: null, error: { message: 'not found' } };
          if (st.consented) return { data: { redirect_url: 'https://claude.example/cb?code=again' }, error: null };
          return { data: { authorization_id: id, client: { id: 'cl-1', name: 'Claude', uri: '', logo_uri: '' }, redirect_uri: 'https://claude.example/cb', scope: 'openid email', user: { id: 'u1', email: 't@x.com' } }, error: null }; },
        approveAuthorization: async (id) => { st.calls.push(['approve', id]); save(); return { data: { redirect_url: 'https://claude.example/cb?code=abc' }, error: null }; },
        denyAuthorization: async (id) => { st.calls.push(['deny', id]); save(); return { data: { redirect_url: 'https://claude.example/cb?error=access_denied' }, error: null }; },
        listGrants: async () => ({ data: st.sbGrants, error: null }),
        revokeGrant: async ({ clientId }) => { st.calls.push(['revokeGrant', clientId]); save(); return { data: {}, error: null }; },
      },
    } }; } };
})();`;

{
  const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
  await serveFromDisk(ctx);
  await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: fakeOAuth }));
  await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
  await ctx.route('https://claude.example/**', r => r.fulfill({ contentType: 'text/html', body: '<p>back at the assistant</p>' }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const st = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('__oa')));

  await page.goto(BASE + '/oauth-consent.html'); await page.waitForTimeout(300);
  check('no authorization_id: explains', /missing its connection request/.test(await page.textContent('#stError')));

  await page.goto(BASE + '/oauth-consent.html?authorization_id=auth-1'); await page.waitForTimeout(300);
  check('signed out: sign-in form', await page.isVisible('#stSignIn'));
  await page.fill('#email', 't@x.com'); await page.fill('#password', 'wrong'); await page.click('#signInBtn'); await page.waitForTimeout(200);
  check('wrong password: message', /didn't match/.test(await page.textContent('#signInErr')));
  await page.fill('#password', 'right'); await page.click('#signInBtn'); await page.waitForTimeout(300);
  check('after sign-in: consent for Claude, as @tester', await page.isVisible('#stConsent')
    && (await page.textContent('#stConsent h1')).includes('Claude') && (await page.textContent('#whoText')).includes('@tester'));
  const boxes = await page.$$eval('#scopeList input', els => els.map(e => [e.value, e.checked, e.disabled]));
  check('read scope needed and locked; write scopes off by default',
    JSON.stringify(boxes) === JSON.stringify([['inventory:read', true, true], ['inventory:write', false, false], ['sales:write', false, false], ['offers:write', false, false]]));
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check('no sideways scroll', noScroll);
  await page.check('#scopeList input[value="sales:write"]');
  await page.click('#allowBtn'); await page.waitForURL('https://claude.example/**');
  const s1 = JSON.parse(await page.evaluate(() => sessionStorage.getItem('__oa')) || 'null');
  check('Allow: back to the assistant with a code', page.url().includes('code=abc'));
  // sessionStorage belongs to the other origin now; read it from the consent origin
  await page.goto(BASE + '/oauth-consent.html?authorization_id=auth-1'); await page.waitForTimeout(300);
  const calls = (await st()).calls;
  const grant = calls.find(c => c[0] === 'assistant_grant_consent');
  check('approval saved before Supabase is told, with the chosen scopes',
    grant && grant[1].p_client_id === 'cl-1' && grant[1].p_client_name === 'Claude'
    && JSON.stringify(grant[1].p_scopes) === '["inventory:read","sales:write"]'
    && calls.findIndex(c => c[0] === 'assistant_grant_consent') < calls.findIndex(c => c[0] === 'approve'));

  await page.click('#denyBtn'); await page.waitForURL('https://claude.example/**');
  check('Deny: back to the assistant with access_denied', page.url().includes('error=access_denied'));

  // Already consented in Supabase but disconnected in CardShow: revoke Supabase's consent, ask to start again.
  await page.goto(BASE + '/oauth-consent.html?authorization_id=auth-2');
  await page.evaluate(() => { const s = JSON.parse(sessionStorage.getItem('__oa')); s.consented = true;
    s.sbGrants = [{ client: { id: 'cl-1', name: 'Claude' } }]; s.ourGrants = [{ client_id: 'cl-1', revoked_at: '2026-11-01' }]; s.calls = [];
    sessionStorage.setItem('__oa', JSON.stringify(s)); });
  await page.reload(); await page.waitForTimeout(400);
  check('disconnected assistant: Supabase consent revoked, asked to start again',
    /disconnected/.test(await page.textContent('#stError')) && (await st()).calls.some(c => c[0] === 'revokeGrant' && c[1] === 'cl-1'));
  await page.evaluate(() => { const s = JSON.parse(sessionStorage.getItem('__oa')); s.ourGrants = [{ client_id: 'cl-1', revoked_at: null }];
    sessionStorage.setItem('__oa', JSON.stringify(s)); });
  await page.goto(BASE + '/oauth-consent.html?authorization_id=auth-3'); await page.waitForURL('https://claude.example/**');
  check('still approved in CardShow: goes straight back', page.url().includes('code=again'));

  await page.goto(BASE + '/manifest.webmanifest');
  await page.evaluate(() => { const s = JSON.parse(sessionStorage.getItem('__oa')); s.consented = false; s.seller = null; sessionStorage.setItem('__oa', JSON.stringify(s)); });
  await page.goto(BASE + '/oauth-consent.html?authorization_id=auth-4'); await page.waitForTimeout(400);
  check('buyer account: dealer accounts only', await page.isVisible('#stNotSeller'));
  await page.goto(BASE + '/oauth-consent.html?authorization_id=bad'); await page.waitForTimeout(400);
  check('expired request: explains', /expired/.test(await page.textContent('#stError')));
  check('consent page: no script errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── Profile → Connected assistants ───────────────────────────────────────────
{
  const extra = `;(() => { const orig = window.supabase.createClient; window.supabase.createClient = function () {
    const c = orig.apply(this, arguments); const rpc = c.rpc;
    c.rpc = (n, a) => { if (n !== 'assistant_revoke_client') return rpc(n, a);
      window.__mockLog.push({ table: 'rpc', op: n, payload: a });
      const g = (window.__srv.mcp_client_grants || []).find(x => x.client_id === a.p_client_id); if (g) g.revoked_at = new Date().toISOString();
      localStorage.setItem('__srv', JSON.stringify(window.__srv)); return Promise.resolve({ data: { ok: true, revoked: !!g }, error: null }); };
    c.auth.oauth = { revokeGrant: async (o) => { window.__mockLog.push({ table: 'oauth', op: 'revokeGrant', payload: o }); return { data: {}, error: null }; } };
    return c; }; })();`;
  const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
  const today = new Date().toLocaleDateString('en-CA');
  await ctx.addInitScript(([today]) => { localStorage.setItem('smExited:tester', 'show_a|' + today); window.confirm = () => true; }, [today]);
  await serveFromDisk(ctx);
  await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{}' }));
  await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock + extra }));
  await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/app.html'); await page.waitForTimeout(400);
  await page.evaluate(() => {
    const S = window.__srv; const ago = h => new Date(Date.now() - h * 3600000).toISOString();
    S.mcp_client_grants = [
      { user_id: 'u1', client_id: 'cl-1', client_name: 'Claude', scopes: ['inventory:read', 'sales:write'], created_at: ago(48), last_used_at: ago(2), revoked_at: null },
      { user_id: 'u1', client_id: 'cl-old', client_name: 'Old bot', scopes: ['inventory:read'], created_at: ago(200), last_used_at: null, revoked_at: ago(100) },
    ];
    S.agent_actions = [
      { owner_id: 'u1', actor_type: 'dealer_agent', client_name: 'Claude', tool: 'set_price', status: 'applied', created_at: ago(1) },
      { owner_id: 'u1', actor_type: 'dealer_agent', client_name: 'Claude', tool: 'record_sale', status: 'previewed', created_at: ago(1.5) },
      { owner_id: 'u1', actor_type: 'dealer_agent', client_name: 'Claude', tool: 'get_price_suggestion', status: 'read', created_at: ago(2) },
      { owner_id: 'u1', actor_type: 'dealer_agent', client_name: 'Claude', tool: 'list_my_inventory', status: 'failed', created_at: ago(3) },
    ];
    localStorage.setItem('__srv', JSON.stringify(S));
  });
  const signIn = async (url) => {
    await page.goto(BASE + url); await page.waitForTimeout(400);
    await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
    await page.evaluate(() => submitAuth()); await page.waitForTimeout(2500);
  };
  await signIn('/app.html');
  await page.evaluate(() => openProfile()); await page.waitForTimeout(500);
  check('switch off: no Connected assistants section', !(await page.isVisible('#assistantsSection')));
  await page.evaluate(() => { closeProfile(); signOut(); }); await page.waitForTimeout(500);

  await signIn('/app.html?assistants=1');
  await page.evaluate(() => openProfile()); await page.waitForTimeout(700);
  const rows = await page.$$eval('#assistantsList .ca-row', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  check('lists connected assistants only (revoked one hidden), with scopes and last used',
    rows.length === 1 && rows[0].includes('Claude') && rows[0].includes('Record sales') && rows[0].includes('2 h ago'), JSON.stringify(rows));
  check('shows the connector URL', (await page.textContent('#assistantsHint')).includes('https://getcardshow.com/mcp/seller'));
  await page.click('#assistantActivityWrap summary');
  const acts = await page.$$eval('#assistantActivity .ca-act', els => els.map(e => e.textContent));
  check('assistant activity listed: changes, previews, reads, failures', acts.length === 4 && acts[0].includes('Changed a price')
    && acts[1].includes('Asked to record a sale') && acts[2].includes('Got price suggestions') && acts[3].includes("didn't work"), JSON.stringify(acts));
  await page.click('.ca-disconnect'); await page.waitForTimeout(600);
  const log = await page.evaluate(() => window.__mockLog.filter(l => l.op === 'assistant_revoke_client' || l.op === 'revokeGrant').map(l => l.op));
  check('Disconnect: CardShow approval revoked, then Supabase consent', JSON.stringify(log) === '["assistant_revoke_client","revokeGrant"]');
  check('…and the list is empty', (await page.textContent('#assistantsList')).includes('No assistants connected'));
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check('profile: no sideways scroll', noScroll);
  check('app: no script errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
