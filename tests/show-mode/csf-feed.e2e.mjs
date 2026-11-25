// The Card Shop Finder feed in the dealer app: Show Directory → Show feed (platform owner), the Card Shop Finder
// filter and credit on Directory rows, and the credit in a seller's Join a show list and pickup picker.
// Run like show-mode.e2e.mjs:   node csf-feed.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); };
const today = new Date().toLocaleDateString('en-CA');
const URL_ = 'https://thecardshopfinder.com/event/dallas-card-show/?utm_source=cardshow&utm_medium=partner_feed&utm_campaign=events';
const syncCalls = [];

async function setup(extra, asAdmin) {
  const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
  await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
  await ctx.route('**/.netlify/functions/csf-feed-admin', r => {
    syncCalls.push({ body: JSON.parse(r.request().postData() || '{}'), auth: r.request().headers().authorization });
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, received: 812, shows_created: 3, removed: 1 }) });
  });
  await ctx.route('**/.netlify/functions/**', r => r.request().url().includes('csf-feed-admin') ? r.fallback()
    : r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
  await page.goto(BASE + '/app.html?show_mode=1&marketplace=1');
  await page.waitForTimeout(400);
  await page.evaluate(seedShows, { today, URL_ });
  if (extra) await page.evaluate(extra, { today, URL_ });
  if (asAdmin) await page.evaluate(() => {
    authRoleSelected = 'admin';
    document.getElementById('authAdminEmail').value = 't@x.com';
    document.getElementById('authAdminPass').value = 'password1';
  });
  else { await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1'); }
  await page.evaluate(() => submitAuth());
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const seedShows = ({ today, URL_ }) => {
  const S = window.__srv;
  S.sellers = [{ id: 'u1', handle: 'dealer_a', display_name: 'Dealer A', onboarding_complete: true }];
  S.admins = [{ id: 'u1' }];
  S.platform_admins = [{ id: 'u1' }];
  S.shows = [
    { id: 'show_csf1', name: 'Dallas Card Show', date: 'Soon', start_date: today, end_date: today, venue: 'Hall 1', city: 'Dallas', state: 'TX',
      location: 'Hall 1, Dallas, TX', status: 'active', listed: true, seller_self_join: true, source: 'csf', external_event_id: 'ev1', slug: 'dallas-card-show' },
    { id: 'show_org', name: 'Monster Show', start_date: today, end_date: today, venue: 'Cal Expo', city: 'Sacramento', state: 'CA',
      status: 'active', listed: true, created_by: 'u1', seller_self_join: true },
  ];
  S.external_events = [{ id: 'ev1', source_url: URL_, time_start: '09:00', time_end: null, admission_price: 0, status: 'active' }];
  S.show_sellers = [];
  localStorage.setItem('__srv', JSON.stringify(S));
};

// ── Platform owner: Show feed ──
{
  const { ctx, page, errors } = await setup(args => {
    const S = window.__srv;
    const now = new Date().toISOString();
    S.csf_feed = {
      runs: [{ id: 'r1', started_at: now, finished_at: now, ok: true, trigger: 'schedule', events_received: 812, inserted: 3, updated: 809, ended: 4, removed: 1,
               shows_created: 3, shows_linked: 1, matches_pending: 1 }],
      counts: { active_events: 812, csf_shows: 640, linked_shows: 5, no_coords: 12 },
      matches: [{ id: 'm1', score: 0.42, reasons: { name_similarity: 0.42, same_city: true },
        event: { name: 'West Coast Hobby Expo', date_start: args.today, date_end: args.today, venue: 'Mall', city: 'Lakewood', state: 'CA', url: args.URL_ },
        show: { id: 'show_org', name: 'WCHE Lakewood', start_date: args.today, end_date: args.today, venue: 'Mall', city: 'Lakewood', state: 'CA' } }],
      removals: [{ id: 'x1', kind: 'hidden', removed_at: now, show: { id: 'show_gone', name: 'Gone Show', date: 'Dec 1, 2026', city: 'Austin', state: 'TX' },
        listings: [{ id: 'c1', title: 'Charizard PSA 10', stock_code: 'S-1' }], holds: [{ id: 'h1', buyer_name: 'Cal' }], offers: [],
        emails: { queued: 2, sent: 2 } }],
    };
    localStorage.setItem('__srv', JSON.stringify(S));
  }, true);
  await page.evaluate(() => switchAdminTab('directory'));
  await page.waitForTimeout(800);
  const box = page.locator('#dirFeed');
  check('show feed: last sync, counts and what needs a look', await box.isVisible()
    && /812 events · 3 new · 809 updated · 4 ended · 1 removed/.test(await box.textContent())
    && /640 upcoming shows from it/.test(await box.textContent()) && /1 to review · 1 removed show/.test(await box.textContent()));
  await page.click('#dirFeed button:has-text("Details")');
  check('details: match side by side, credit to the exact url', /West Coast Hobby Expo/.test(await box.textContent())
    && /WCHE Lakewood/.test(await box.textContent()) && (await box.locator(`a.csf-credit[href="${URL_}"]`).count()) >= 1
    && /name 42% alike · same city/.test(await box.textContent()));
  check('details: removed show with its listing, hold to follow up, emails', /Charizard PSA 10/.test(await box.textContent())
    && /Open holds to follow up: Cal/.test(await box.textContent()) && /2 of 2 sent/.test(await box.textContent()));
  await page.click('#dirFeed button:has-text("Same show: link")');
  await page.waitForTimeout(700);
  check('link a match: saved', (await page.evaluate(() => window.__srv.csf_resolved || []))
    .some(a => a.p_match === 'm1' && a.p_action === 'link'));
  await page.click('#dirFeed button:has-text("Run sync now")');
  await page.waitForTimeout(900);
  check('run sync now: calls the admin function with the session', syncCalls.length === 1 && syncCalls[0].body.action === 'run'
    && /^Bearer /.test(syncCalls[0].auth || '') && /Synced: 812 events/.test(await page.textContent('#toast')));
  // The Directory's Card Shop Finder filter and rows.
  await page.click('#dirFilters button:has-text("Card Shop Finder")');
  const row = page.locator('.dir-row[data-show-id="show_csf1"]');
  check('directory: Card Shop Finder filter, badge, feed note and credit', (await row.count()) === 1
    && /Card Shop Finder/.test(await row.locator('.dir-badge.csf').textContent()) && /kept in sync/.test(await row.textContent())
    && (await row.locator('a.csf-credit').getAttribute('href')) === URL_
    && (await page.locator('.dir-row[data-show-id="show_org"]').count()) === 0);
  check('directory: no sideways scroll', await noSideScroll(page));
  check('no page errors (owner)', errors.length === 0, JSON.stringify(errors));
  await ctx.close();
}

// ── Seller: Join a show list and pickup picker ──
{
  const { ctx, page, errors } = await setup(null, false);
  await page.evaluate(() => openJoinShow());
  await page.waitForTimeout(500);
  const rowText = await page.locator('#joinShowList').textContent();
  const credit = page.locator('#joinShowList a.csf-credit');
  check('join list: CSF show credited to the exact url, hours TBD, free entry', (await credit.count()) === 1
    && (await credit.getAttribute('href')) === URL_ && (await credit.getAttribute('target')) === '_blank'
    && /Hours TBD · Free entry/.test(rowText));
  // Join it, then it's a pickup choice with the credit under it.
  await page.click('#joinShowList .join-show-row:has-text("Dallas Card Show") .join-show-btn');
  await page.waitForTimeout(900);
  const html = await page.evaluate(() => { const sel = document.createElement('select'); sel.innerHTML = mkPickupOptionsHTML('show_csf1');
    const d = document.createElement('div'); d.id = 'tmpCredit'; document.body.append(sel, d); mkPickupCredit(sel, 'tmpCredit'); return d.innerHTML; });
  check('pickup picker: the chosen CSF show is credited', html.includes(URL_.replace(/&/g, '&amp;')) && /via The Card Shop Finder/.test(html), html);
  await page.evaluate(() => { shows.show_csf1.feedRemovedAt = new Date().toISOString(); });
  check('pickup picker: a show that left the feed isn\'t offered', await page.evaluate(() => !mkPickupShows().some(s => s.id === 'show_csf1')));
  check('no page errors (seller)', errors.length === 0, JSON.stringify(errors));
  await ctx.close();
}

await browser.close();
console.log(fails ? `${fails} FAILED (${deviceName})` : `all passed (${deviceName})`);
if (fails) process.exit(1);
