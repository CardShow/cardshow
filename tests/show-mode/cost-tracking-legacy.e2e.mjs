// Cost Tracking before 20261114120000_cost_tracking.sql has run: cost tables and the
// stock-code RPCs are missing. Adding cards and selling must work exactly as before.
//   node cost-tracking-legacy.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
let mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
// Cost tables don't exist; stock-code RPCs don't exist.
mock = mock.replace('function q(table){', `function q(table){
    if (table === 'inventory_costs' || table === 'transaction_costs') {
      const err = { data: null, error: { code: '42P01', message: 'relation "public.' + table + '" does not exist' }, status: 404 };
      const b = new Proxy({}, { get: (_, k) => k === 'then' ? (res, rej) => Promise.resolve(err).then(res, rej) : () => b });
      return b;
    }`).replace('function rpc(name, a){', `function rpc(name, a){
    if (name === 'assign_stock_codes' || name === 'set_stock_code')
      return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + name }, status: 404 });`);
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[process.argv[2] || 'iPhone 13'], serviceWorkers: 'block' });
const today = new Date().toLocaleDateString('en-CA');
await ctx.addInitScript(([today]) => { localStorage.setItem('smExited:tester', 'show_a|' + today); window.confirm = () => true; }, [today]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const wait = ms => page.waitForTimeout(ms);
const srv = () => page.evaluate(() => JSON.parse(localStorage.getItem('__srv')));
await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));

await page.goto(BASE + '/app.html'); await wait(400);
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth()); await wait(2500);

await page.evaluate(() => openAddCard()); await wait(150);
await page.fill('#ac_title', 'Legacy add');
await page.fill('#ac_price', '10');
await page.click('#ac_cost_details summary');
await page.fill('#ac_cost', '4');
await page.fill('#ac_code', 'MY-1');
await page.evaluate(() => saveAddCard()); await wait(900);
let S = await srv();
check('card still saves without the cost migration', S.inventory.some(r => r.card_title === 'Legacy add'));
check('cost kept in memory for the session', await page.evaluate(() => inventory.find(c => c['Card Title'] === 'Legacy add').CostBasis === 4));

await page.evaluate(() => assignStockCodesBulk()); await wait(400);
check('Assign codes says it isn\'t set up', /aren.t set up|Couldn.t assign/.test(await page.textContent('#toast')), await page.textContent('#toast'));

const idx = await page.evaluate(() => inventory.findIndex(c => c._dbId === 'c1'));
await page.evaluate(i => openSellDrawer(i), idx); await wait(200);
await page.fill('#sdPrice', '99');
await page.evaluate(() => { sdSelectedPayment = 'Cash'; sdConfirm(); }); await wait(900);
S = await srv();
check('sale still recorded on inventory', S.inventory.find(r => r.id === 'c1').status === 'Sold');
check('ledger row still written', S.show_floor_transactions.some(r => r.inventory_id === 'c1'));
check('no cost writes left queued', (await page.evaluate(() => smStore.all('outbox'))).filter(o => /cost|stock/.test(o.type)).length === 0);
check('no page errors', errors.length === 0, JSON.stringify(errors));
await browser.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
