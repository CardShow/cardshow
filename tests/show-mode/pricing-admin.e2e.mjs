// Pricing admin tab (platform owner). The pricing-admin function is faked in-page.
//   node pricing-admin.e2e.mjs "iPhone 13"     (serve the repo root on :8765 first)
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// Fake server state for pricing-admin.js
const state = {
  calls: [],
  rows: {
    open: [
      { identity: 'charizard|1999|base set|4|holo|', status: 'no_match', listings: 4, dealers: 2, attempts: 1, grades: ['PSA 10', 'Raw'],
        card: { title: '1999 Pokemon Base Set Charizard Holo', player: 'Charizard', year: 1999, set: 'Base Set', number: '4', parallel: 'Holo' } },
      { identity: 'wemby|2023|prizm|136||', status: 'error', listings: 1, dealers: 1, attempts: 3, grades: ['BGS 9.5'],
        card: { title: 'Wemby Prizm', player: 'Victor Wembanyama', year: 2023, set: 'Prizm', number: '136' } },
    ],
    manual: [], ignored: [], auto: [],
    check: [
      { identity: 'stroud|2024|panini select|42|17/49|', status: 'review', reason: 'parallel_unconfirmed', listings: 1, dealers: 1,
        grades: ['Raw'], card_id: 'ch-stroud-base', match_title: '2024 Panini Select C.J. Stroud #42', value_cents: 69, price_cents: 4000,
        card: { title: '2024 Panini Select C.J. Stroud /49', player: 'C.J. Stroud', year: 2024, set: 'Panini Select', number: '42', parallel: '17/49' } },
    ],
  },
};
function fakePricing(route) {
  const b = JSON.parse(route.request().postData() || '{}');
  state.calls.push(b);
  const ok = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (b.action === 'summary') return ok({ listed: 120, priced: 90, waiting: 25, unmatched: state.rows.open.reduce((n, r) => n + r.listings, 0),
    ignored: state.rows.ignored.length, manual: state.rows.manual.length, check: state.rows.check.length, auto: state.rows.auto.length, cards: { high: 3, normal: 40 }, failing_refreshes: 1,
    last_refresh: new Date().toISOString(), usage_today: { cardhedge: { calls: 4100, uncached: 100, errors: 2 } },
    daily_limit: 5000, cardhedge_key: true, enabled: false });
  if (b.action === 'queue') return ok({ rows: state.rows[b.status || 'open'] });
  if (b.action === 'lookup') {
    if (/nothing/i.test(b.query)) return ok({ found: false });
    if (/busy/i.test(b.query)) return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"cardhedge_http_429"}' });
    return ok({ found: true, card_id: 'ch-zard', confidence: 0.82, title: '1999 Pokemon Base Set Charizard #4 Holo',
      values: [{ grade: 'PSA 10', value_cents: 2100000 }, { grade: 'Raw', value_cents: 50000 }, { grade: 'PSA 9', value_cents: 600000 }], query: b.query });
  }
  if (b.action === 'match') {
    const i = state.rows.open.findIndex(r => r.identity === b.identity);
    const [r] = state.rows.open.splice(i, 1);
    state.rows.manual.push({ ...r, status: 'manual', card_id: b.card_id });
    return ok({ ok: true, listings: r.listings, values: (b.values || []).length });
  }
  if (b.action === 'confirm') {
    const i = state.rows.check.findIndex(r => r.identity === b.identity);
    const [r] = state.rows.check.splice(i, 1);
    state.rows.manual.push({ ...r, status: 'manual' });
    return ok({ ok: true, listings: r.listings });
  }
  if (b.action === 'ignore' || b.action === 'retry') {
    for (const k of ['open', 'manual', 'ignored', 'check', 'auto']) {
      const i = state.rows[k].findIndex(r => r.identity === b.identity);
      if (i >= 0) { const [r] = state.rows[k].splice(i, 1); if (b.action === 'ignore') state.rows.ignored.push({ ...r, status: 'ignored' }); }
    }
    return ok({ ok: true, listings: 1 });
  }
  return route.fulfill({ status: 400, body: '{}' });
}

async function setup(platformOwner) {
  const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
  await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
  await ctx.route('**/.netlify/functions/**', r => r.request().url().includes('pricing-admin') ? fakePricing(r)
    : r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
  await page.goto(BASE + '/app.html');
  await wait(400);
  await page.evaluate(po => {
    const S = window.__srv;
    S.admins = [{ id: 'u1' }];
    S.platform_admins = po ? [{ id: 'u1' }] : [];
    S.shows = [];
    localStorage.setItem('__srv', JSON.stringify(S));
    authRoleSelected = 'admin';
    document.getElementById('authAdminEmail').value = 't@x.com';
    document.getElementById('authAdminPass').value = 'password1';
  }, platformOwner);
  await page.evaluate(() => submitAuth());
  await wait(1500);
  return { ctx, page, errors };
}

// ── organizer (not platform owner): no tab ──
{
  const { ctx, page } = await setup(false);
  check('organizer: no Pricing tab', !(await page.isVisible('#adminTabPricing')));
  await ctx.close();
}

// ── platform owner ──
const { ctx, page, errors } = await setup(true);
check('platform owner sees the Pricing tab with a badge', await page.isVisible('#adminTabPricing')
  && (await page.textContent('#paTabBadge')).trim() === '5');
await page.click('#adminTabPricing'); await wait(500);
const sum = await page.textContent('#paSummary');
check('summary: listed, priced, waiting, couldn\'t match, calls today vs limit', /120/.test(sum) && /90/.test(sum) && /25/.test(sum)
  && /4,100 \/ 5,000/.test(sum) && /82%/.test(sum) && /1 card failing to refresh/.test(sum), sum);
check('note: automatic pricing is off, manual matches still work', /Automatic pricing is off/.test(await page.textContent('#paFilters')));
const chk = await page.textContent('#paList');
check('opens on Needs a check: the matched card, its value next to the asking price, and why it\'s hidden',
  /Needs a check/.test(await page.textContent('.dir-filter.active')) && /Card Hedge: 2024 Panini Select C\.J\. Stroud #42/.test(chk)
  && /value \$0\.69 · asking \$40/.test(chk) && /doesn't name this parallel or print run/.test(chk), chk);
await page.click('#paList button:has-text("Looks right")'); await wait(500);
check('Looks right confirms the automatic match', state.calls.some(c => c.action === 'confirm' && c.identity === 'stroud|2024|panini select|42|17/49|')
  && /Nothing to check/.test(await page.textContent('#paList')));
await page.click('.dir-filter:has-text("Couldn\'t match")'); await wait(400);
check('queue lists both cards, biggest first, with why', (await page.locator('#paList .dir-row').count()) === 2
  && /4 listings · 2 dealers · PSA 10, Raw/.test(await page.textContent('[data-pa-idx="0"]'))
  && /didn't answer \(3 tries\)/.test(await page.textContent('[data-pa-idx="1"]')));

// search filter
await page.fill('#paSearch', 'wemby'); await page.dispatchEvent('#paSearch', 'input'); await wait(100);
check('search narrows the list', (await page.locator('#paList .dir-row').count()) === 1);
await page.fill('#paSearch', ''); await page.dispatchEvent('#paSearch', 'input'); await wait(100);

// find a match
await page.click('[data-pa-idx="0"] button:has-text("Find match")'); await wait(150);
check('lookup box pre-filled without the grade', (await page.inputValue('#paQuery0')) === '1999 Base Set Charizard #4 Holo');
await page.fill('#paQuery0', 'nothing here'); await page.click('[data-pa-idx="0"] button:has-text("Search")'); await wait(300);
check('no result explained', /found nothing/.test(await page.textContent('[data-pa-idx="0"]')));
await page.fill('#paQuery0', 'busy'); await page.press('#paQuery0', 'Enter'); await wait(300);
check('Card Hedge rate limit explained', /rate limit/.test(await page.textContent('[data-pa-idx="0"]')));
await page.fill('#paQuery0', '1999 Base Set Charizard 4'); await page.click('[data-pa-idx="0"] button:has-text("Search")'); await wait(300);
const res = await page.textContent('[data-pa-idx="0"]');
check('result: title, 82% sure flagged below 90%, listed grades first with values', /Charizard #4 Holo/.test(res) && /82% sure/.test(res)
  && /Below the automatic bar/.test(res) && /PSA 10 \$21,000 ✓ · Raw \$500 ✓ · PSA 9 \$6,000/.test(res) && /2 of 2/.test(res), res);
await page.click('[data-pa-idx="0"] button:has-text("Use this match")'); await wait(600);
const m = state.calls.find(c => c.action === 'match');
check('match sends the card, the query and the values from the lookup (no second lookup)',
  m && m.identity === 'charizard|1999|base set|4|holo|' && m.card_id === 'ch-zard' && m.query === '1999 Base Set Charizard 4' && m.values.length === 3
  && state.calls.filter(c => c.action === 'lookup').length === 3);
check('card leaves the queue', (await page.locator('#paList .dir-row').count()) === 1);
await page.click('.dir-filter:has-text("Matched by hand")'); await wait(400);
check('Matched by hand lists it, with Undo', /Matched by hand · card ch-zard/.test(await page.textContent('#paList')) && await page.isVisible('#paList button:has-text("Undo")'));

// hide and bring back
await page.click('.dir-filter:has-text("Couldn\'t match")'); await wait(400);
await page.click('[data-pa-idx="0"] button:has-text("Hide")'); await wait(500);
check('Hide asks first, then hides', state.calls.some(c => c.action === 'ignore' && c.identity === 'wemby|2023|prizm|136||') && /Nothing to fix/.test(await page.textContent('#paList')));
await page.click('.dir-filter:has-text("Hidden")'); await wait(400);
await page.click('#paList button:has-text("Bring back")'); await wait(500);
check('Bring back sends it to the automatic queue', state.calls.some(c => c.action === 'retry' && c.identity === 'wemby|2023|prizm|136||'));

check('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
check('no page errors', errors.length === 0, JSON.stringify(errors));
await ctx.close();
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
