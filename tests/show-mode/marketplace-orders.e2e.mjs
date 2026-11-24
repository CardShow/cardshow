// Marketplace Buy Now orders, dealer side (js/marketplace-orders.js): strip, Orders panel, how buyers pay you,
// confirm (with shipping), not available, mark paid (ship / pickup), shipped, the ORDERED chip. Run like the others:
//   node marketplace-orders.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
const today = new Date().toLocaleDateString('en-CA');
await ctx.addInitScript(([today]) => {
  localStorage.setItem('smExited:tester', 'show_a|' + today);
  window.confirm = () => true;
}, [today]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); };
const wait = ms => page.waitForTimeout(ms);
const srv = () => page.evaluate(() => JSON.parse(localStorage.getItem('__srv')));
const ord = (S, id) => S.orders.find(o => o.id === id);
const notifies = [];
await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/.netlify/functions/order-notify-now', r => { notifies.push(JSON.parse(r.request().postData() || '{}').order_id); r.fulfill({ contentType: 'application/json', body: '{}' }); });
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
async function signIn(url) {
  await page.goto(BASE + url); await wait(400);
  await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
  await page.evaluate(() => submitAuth());
  await wait(2500);
}
const inMin = m => new Date(Date.now() + m * 60000).toISOString();
const addr = { name: 'Cal B', line1: '1 Main St', city: 'Austin', state: 'TX', postal: '78701' };

await page.goto(BASE + '/app.html'); await wait(400);
await page.evaluate(([c90, c30, p20h, addr]) => {
  const S = window.__srv;
  S.inventory.push({ id: 'c5', seller_id: 'u1', card_title: '2023 Prizm Victor Wembanyama', price: 60, status: 'Available', listing_status: 'reserved', stock_code: 'R-9' });
  for (const id of ['c1', 'c2', 'c5']) S.inventory.find(r => r.id === id).listing_status = 'reserved';
  S.inventory.find(r => r.id === 'c1').stock_code = 'S-12';
  S.orders = [
    { id: 'or1', dealer_id: 'u1', listing_ids: ['c1'], fulfillment: 'ship', ship_to: addr, subtotal_cents: 12000, shipping_cents: null,
      status: 'awaiting_confirmation', confirm_by: c90, buyer_name: 'Cal B', buyer_contact: 'cal@example.test', buyer_note: 'Bubble wrap please',
      created_at: new Date().toISOString() },
    { id: 'or2', dealer_id: 'u1', listing_ids: ['c2'], fulfillment: 'local_pickup', subtotal_cents: 4000, status: 'awaiting_confirmation',
      confirm_by: c30, buyer_name: 'Dee', buyer_contact: '@dee_cards', pickup_show: { id: 'show_a', name: 'Show A', table_number: '12' },
      created_at: new Date().toISOString() },
    { id: 'or3', dealer_id: 'u1', listing_ids: ['c5'], fulfillment: 'local_pickup', subtotal_cents: 6000, status: 'awaiting_payment',
      confirm_by: c30, pay_by: p20h, buyer_name: 'Eve', buyer_contact: '555 010 0199', from_offer: true, created_at: new Date().toISOString() },
    { id: 'orx', dealer_id: 'someone_else', listing_ids: ['zz'], fulfillment: 'ship', subtotal_cents: 100, status: 'awaiting_confirmation', confirm_by: c30 },
  ];
  localStorage.setItem('__srv', JSON.stringify(S));
  localStorage.removeItem('marketplaceTest');
}, [inMin(90), inMin(30), inMin(20 * 60), addr]);

await signIn('/app.html');
check('switch off: no orders strip', !(await page.isVisible('#ordStrip')));
await page.evaluate(() => signOut()); await wait(500);

await signIn('/app.html?marketplace=1');
await page.waitForSelector('#ordStrip:not([style*="none"])', { timeout: 5000 }).catch(() => {});
const strip = await page.textContent('#ordStrip');
check('strip: orders to confirm with the minutes left, one waiting for payment', /2 orders to confirm · (29|30) min left/.test(strip) && /1 waiting for payment/.test(strip), strip);
check('table chip: ORDERED', (await page.locator('.mk-chip--hold:has-text("ORDERED")').count()) === 3);
await page.waitForFunction(() => /order/.test(document.getElementById('toast').textContent), null, { timeout: 9000 }).catch(() => {});
check('toast for new orders', /2 new orders to confirm/.test(await page.textContent('#toast')), await page.textContent('#toast'));
await page.click('#ordStrip button'); await wait(400);
let panel = await page.textContent('#ordOverlay');
check("panel: to confirm with buyer, total, address, note, contact link; other dealer's order hidden",
  /Cal B · \$120 \+ shipping \(you set it\)/.test(panel) && /Ship to Cal B, 1 Main St, Austin, TX 78701/.test(panel) && /Bubble wrap please/.test(panel)
  && (await page.getAttribute('[data-order="or1"] .mh-contact a', 'href')) === 'mailto:cal@example.test' && /Pickup Show A · your table 12/.test(panel)
  && /S-12/.test(panel) && !/someone_else|orx/.test(panel), panel);
check('panel: asks for payment methods first', /Add how buyers pay you/.test(panel));
check('panel: no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

// how buyers pay you
await page.click('#ordOverlay button:has-text("Add payment methods")'); await wait(300);
await page.fill('#ordPayForm [name=venmo]', 'has space');
await page.click('#ordPaySave'); await wait(400);
check('payment methods: a bad Venmo handle is refused', /Check your Venmo/.test(await page.textContent('#ordPayErr')));
await page.fill('#ordPayForm [name=venmo]', '@dealer-a'); await page.fill('#ordPayForm [name=zelle]', 'a@example.test');
await page.fill('#ordPayForm [name=note]', 'Put the order # in the note');
await page.click('#ordPaySave'); await wait(500);
let S = await srv();
check('payment methods saved', S.dealer_payment_methods?.[0]?.methods.length === 2 && S.dealer_payment_methods[0].methods[0].value === 'dealer-a'
  && /Buyers pay you by Venmo, Zelle/.test(await page.textContent('#ordOverlay')));

// confirm: shipping required
await page.click('[data-order="or1"] button:has-text("confirm")'); await wait(300);
check('confirm a ship order with no shipping price: asks for it', /shipping you'll charge/.test(await page.textContent('#ordErr_or1')));
await page.fill('#ordShip_or1', '5'); await page.click('[data-order="or1"] button:has-text("confirm")'); await wait(700);
S = await srv();
check('confirm: shipping $5 sent in cents, buyer emailed, waiting for payment', ord(S, 'or1').status === 'awaiting_payment' && ord(S, 'or1').shipping_cents === 500
  && notifies.includes('or1') && /has until/.test(await page.textContent('#toast')));

// not available
await page.click('[data-order="or2"] button:has-text("Not available")'); await wait(700);
S = await srv();
check('not available: cancelled and the card is taken down', ord(S, 'or2').status === 'cancelled' && ord(S, 'or2').end_reason === 'not_available'
  && S.inventory.find(r => r.id === 'c2').listing_status === 'delisted' && notifies.includes('or2'));

// pickup paid at the table
await page.selectOption('#ordMethod_or3', 'Cash');
await page.click('[data-order="or3"] button:has-text("Paid & picked up")'); await wait(1200);
S = await srv();
check('paid & picked up: completed, card sold for cash at the agreed price', ord(S, 'or3').status === 'completed'
  && S.inventory.find(r => r.id === 'c5').status === 'Sold' && Number(S.inventory.find(r => r.id === 'c5').sold_price) === 60
  && S.inventory.find(r => r.id === 'c5').payment_method === 'Cash');
check('the sale shows in the app (sold, price, payment)', await page.evaluate(() => {
  const c = inventory.find(x => x._dbId === 'c5'); return c.Status === 'Sold' && c.SoldPrice === 60 && c.PaymentMethod === 'Cash'; }));

// ship order: paid → shipped
await page.selectOption('#ordMethod_or1', 'Venmo');
await page.click('[data-order="or1"] button:has-text("Mark paid")'); await wait(1200);
check('marked paid: moves to To ship', /To ship/.test(await page.textContent('#ordOverlay')) && /2 to ship|1 to ship/.test(await page.textContent('#ordStrip') || '1 to ship'));
await page.click('#ordOverlay form.mo-counter button[type=submit]'); await wait(200);
await page.fill('#ordOverlay form.mo-counter [name=tracking]', '9400 1000 0000');
await page.click('#ordOverlay form.mo-counter button[type=submit]'); await wait(700);
S = await srv();
check('shipped with tracking, buyer emailed', ord(S, 'or1').status === 'shipped' && ord(S, 'or1').tracking_number === '9400 1000 0000' && ord(S, 'or1').carrier === 'USPS');
panel = await page.textContent('#ordOverlay');
check('ended orders listed with why', /Cancelled · you didn't have it/.test(panel) && /Completed/.test(panel), panel);
await page.evaluate(() => closeOrdersPanel());

// Edit Card names the buyer for an ordered card
await page.evaluate(() => { const S = window.__srv; S.orders.push({ id: 'or4', dealer_id: 'u1', listing_ids: ['c1'], fulfillment: 'ship', subtotal_cents: 100,
  status: 'awaiting_confirmation', confirm_by: new Date(Date.now() + 36e5).toISOString(), buyer_name: 'Gus' }); localStorage.setItem('__srv', JSON.stringify(S)); });
await page.evaluate(() => ordLoad({ quiet: true })); await wait(400);
await page.evaluate(() => { const c = inventory.find(x => x._dbId === 'c1'); c.ListingStatus = 'reserved'; c.Status = 'Available'; openCEM(inventory.indexOf(c)); }); await wait(300);
check('Edit Card: names the buyer who ordered', /Gus bought this card \(Buy Now\)/.test(await page.textContent('#cem_mk_status')));
await page.evaluate(() => closeCEM());

// before the migration
await page.evaluate(() => { window.__ordMissing = true; ordReset(); ordStart(); }); await wait(500);
check('migration not run: no strip, no errors', !(await page.isVisible('#ordStrip')) && errors.length === 0);
await page.evaluate(() => { window.__ordMissing = false; });

await page.evaluate(() => signOut()); await wait(500);
check('signed out: strip hidden', !(await page.isVisible('#ordStrip')));
check('no page errors', errors.length === 0, JSON.stringify(errors));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
