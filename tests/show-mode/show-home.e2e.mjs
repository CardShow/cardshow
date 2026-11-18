// Show Home (Trades + Show Home, Phase 2: js/show-home.js). Run like the others:
//   node show-home.e2e.mjs "iPhone 13"
// The report is a synthetic copy of TitoCollects' Nov 7 numbers (the spec's table) with
// made-up card names, so no dealer data is in the repo. The SQL side is checked against
// the real fixture by trades.test.sh.
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block', acceptDownloads: true });
const today = new Date().toLocaleDateString('en-CA');
await ctx.addInitScript(([today]) => {
  Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get() { return localStorage.getItem('__offline') !== '1'; } });
  if (!localStorage.getItem('__keepClassic')) localStorage.setItem('smExited:tester', 'show_a|' + today);   // start in the classic view
  window.confirm = () => true;
}, [today]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const wait = ms => page.waitForTimeout(ms);
const srv = () => page.evaluate(() => JSON.parse(localStorage.getItem('__srv')));
const panel = () => page.textContent('#showHomePanel');
const setOffline = on => page.evaluate(on => { localStorage.setItem('__offline', on ? '1' : '0'); if (!on) window.dispatchEvent(new Event('online')); }, on);

await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));

// Synthetic report: the spec's numbers, 29 rows (15 wins, 3 losses, 11 even), two unbalanced trades.
function report() {
  const rows = [];
  const add = (n, type, cost, value) => { for (let i = 0; i < n; i++) rows.push({ code: `S-${rows.length + 1}`, title: `Test card ${rows.length + 1}`, cost, value, profit: value - cost,
    result: value > cost ? 'Win' : value < cost ? 'Loss' : 'Even', type, txn_id: type === 'trade' ? 'dtx-08' : 'sale-1', item_id: 'item-' + rows.length, price_basis: 'observed', at: '2026-11-07T12:00:00Z' }); };
  add(14, 'trade', 100, 120); add(1, 'sale', 10, 90);            // 15 wins
  rows.push({ code: 'S-21', title: 'Test card loss', cost: 500, value: 410, profit: -90, result: 'Loss', type: 'trade', txn_id: 'dtx-08', item_id: 'item-l1', at: '2026-11-07T12:00:00Z' });
  rows.push({ code: 'S-14', title: 'Test card loss 2', cost: 330, value: 310, profit: -20, result: 'Loss', type: 'trade', txn_id: 'dtx-08', item_id: 'item-l2', at: '2026-11-07T12:00:00Z' });
  rows.push({ code: 'S-75', title: 'Test card loss 3', cost: 100, value: 90, profit: -10, result: 'Loss', type: 'trade', txn_id: 'dtx-08', item_id: 'item-l3', at: '2026-11-07T12:00:00Z' });
  add(11, 'trade', 50, 50);                                      // 11 even
  return {
    cards_out: 29, net_pl: 240, margin_on_cost: 0.07441860465116279, trade_value_gained: 145, cash_sale_profit: 95,
    wins: 15, losses: 3, even: 11, win_rate: 0.5172413793103449, biggest_win: 100, biggest_loss: -90,
    trade_cards: 23, trade_cost: 2925, trade_value: 3070, trade_gain: 145, trade_gain_on_cost: 0.04957264957264957,
    cash_cards: 6, cash_cost: 300, cash_value: 395, cash_profit: 95, cash_margin: 0.31666666666666665,
    in_cards: 68, in_cost: 5956, in_ask: 7726, in_ask_gain: 1770, in_ask_gain_pct: 0.2971793149764943,
    onhand_cards: 56, onhand_cost: 4256, onhand_ask: 5596, onhand_ask_gain_pct: 0.3148496240601504,
    cash_received: 395, cash_paid: 20, net_cash: 375, cost_coverage: 1, cards_missing_cost: 0,
    unbalanced_trades: 2, ungrouped_cards: 12, needs_review: 0,
    mix: { traded: { cards: 23, value: 3070 }, cash_sale: { cards: 4, value: 195 }, lot: { cards: 2, value: 200 } },
    rows, unbalanced: [{ txn_id: 'dtx-08', delta: -100 }, { txn_id: 'dtx-09', delta: 25 }], ungrouped_txn_ids: ['dtx-99'],
    snapshot_start: null, snapshot_end: null, growth_cards: null, growth_cost: null, growth_ask: null,
  };
}
const zero = { cards_out: 0, net_pl: 0, wins: 0, losses: 0, even: 0, in_cards: 0, rows: [], mix: {}, unbalanced: [], ungrouped_txn_ids: [],
  unbalanced_trades: 0, ungrouped_cards: 0, needs_review: 0, cards_missing_cost: 0 };
const missing = Object.assign(report(), { cost_coverage: 28 / 29, cards_missing_cost: 1, unbalanced_trades: 0, ungrouped_cards: 0, unbalanced: [], ungrouped_txn_ids: [] });
missing.rows = missing.rows.map((x, i) => i === 0 ? Object.assign({}, x, { cost: null, item_id: 'item-missing' }) : x);

await page.goto(BASE + '/app.html');
await wait(400);
await page.evaluate(([rep, zero, missing]) => {
  const S = window.__srv;
  S.__showList = [
    { show_id: null, dealer_show_id: 'ds-mall', name: 'Mall Show', start_date: '2026-11-07', kind: 'private', cards_out: 29, net_pl: 240, missing_cost: 0 },
    { show_id: 'show_a', dealer_show_id: null, name: 'Monster Show', start_date: null, date_text: 'Today', kind: 'cardshow', cards_out: 0, net_pl: 0, missing_cost: 0 },
    { show_id: null, dealer_show_id: 'ds-miss', name: 'Swap Meet', start_date: '2026-11-01', kind: 'private', cards_out: 29, net_pl: 240, missing_cost: 1 },
  ];
  S.__reports = { 'ds-mall': rep, show_a: zero, 'ds-miss': missing };
  S.dealer_transactions = [{ id: 'dtx-08', txn_type: 'trade', cash_in: 0, cash_out: 0, occurred_at: '2026-11-07T12:00:00Z', review_note: 'Captain Pikachu trade.' }];
  S.transaction_items = [
    { id: 'i1', sale_key: 'dtx-08', dealer_txn_id: 'dtx-08', direction: 'out', card_title: 'Out card A', price: 100, card_ref: { stock_code: 'S-67' } },
    { id: 'i2', sale_key: 'dtx-08', dealer_txn_id: 'dtx-08', direction: 'out', card_title: 'Out card B', price: 190, card_ref: { stock_code: 'S-76' } },
    { id: 'i3', sale_key: 'dtx-08', dealer_txn_id: 'dtx-08', direction: 'in', card_title: 'In card', price: 390, card_ref: { stock_code: 'S-80' } },
  ];
  S.inventory_costs = [{ inventory_id: 'c1', owner_id: 'u1', cost_basis: 50 }, { inventory_id: 'c2', owner_id: 'u1', cost_basis: 15 }];
  S.inventory_snapshots = [];
  localStorage.setItem('__srv', JSON.stringify(S));
}, [report(), zero, missing]);
await page.reload(); await wait(400);
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(2500);

// ── Show list ──
check('Shows tab button for sellers', await page.isVisible('#sellerTabShows'));
await page.click('#sellerTabShows'); await wait(400);
let t = await panel();
check('list shows each show with net P/L', t.includes('Mall Show') && t.includes('+$240') && t.includes('Monster Show') && t.includes('Swap Meet'));
check('running all-time total', (await page.textContent('.sh-alltime')).includes('+$480'), await page.textContent('.sh-alltime'));
check('inventory table hidden on the Shows tab', !(await page.isVisible('.table-wrap')));

// ── Show Home: the spec's numbers, formatted ──
await page.click('.sh-show-row >> nth=0'); await wait(400);
t = await panel();
const kpis = await page.textContent('.sh-kpis');
for (const v of ['+$240', '7.4%', '+$145', '+$95', '51.7%', '15 / 3 / 11', '29 cards out']) check(`KPI shows ${v}`, kpis.includes(v), kpis.replace(/\s+/g, ' ').slice(0, 200));
for (const v of ['$2,925', '$3,070', '5.0%', '$300', '$395', '31.7%', '$5,956', '$7,726', '+$1,770', '29.7%', '$4,256', '$5,596', '31.5%'])
  check(`section shows ${v}`, t.includes(v));
check('two donuts with text labels', await page.locator('.sh-donut svg').count() === 2 && ['Traded 23', 'Cash sale 4', 'Lot 2', 'Win 15', 'Loss 3', 'Even 11'].every(x => t.includes(x)));
check('donut arcs drawn (3 + 3 segments)', await page.locator('.sh-donut svg circle[stroke-dasharray]').count() === 6);
await page.click('.sh-toggle button:has-text("Value")'); await wait(100);
check('What left by value', (await panel()).includes('Traded $3,070') && (await page.textContent('.sh-donut-num')).includes('$3,465'));
check('29 transaction rows', await page.locator('.sh-table tbody tr').count() === 29);
await page.click('.sh-sort:has-text("Profit")'); await wait(100);
check('sort by profit: biggest loss first', (await page.textContent('.sh-table tbody tr >> nth=0')).includes('−$90'));
await page.click('.sh-sort:has-text("Profit")'); await wait(100);
check('sort again: biggest win first', (await page.textContent('.sh-table tbody tr >> nth=0')).includes('+$80'));
check('data-quality strip', t.includes("2 trades don't balance") && t.includes('12 cards traded with no record of what came back'));
check('no snapshot yet', t.includes('Inventory snapshot not taken for this show'));

// Trade detail from the quality strip
await page.click('.sh-q >> nth=0'); await wait(500);
let modal = await page.textContent('.sh-modal');
check('trade detail: both sides with values', modal.includes('Out · $290') && modal.includes('In · $390') && modal.includes('S-80'));
check('trade detail: unbalanced by $100', modal.includes('$100 more came in than went out'));
await page.click('.sh-modal button:has-text("Done")');

// CSV
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export CSV")')]);
const csv = fs.readFileSync(await dl.path(), 'utf8');
check('CSV: 29 card rows + summary', csv.split('\n').filter(l => /^"S-\d+"/.test(l)).length === 29 && csv.includes('"Net P/L","240.00"') && csv.includes('"Win rate","51.7%"'));
check('CSV has no payment or photo data', !/payment|photo|venmo/i.test(csv));

// ── Start snapshot from Show Home ──
await page.click('button:has-text("Take start snapshot now")'); await wait(1200);
let S = await srv();
check('start snapshot written once for the show', S.inventory_snapshots.filter(x => x.kind === 'show_start' && x.dealer_show_id === 'ds-mall').length === 1);

// ── Missing cost → Add cost ──
await page.click('.sh-back'); await wait(400);
await page.click('.sh-show-row:has-text("Swap Meet")'); await wait(400);
t = await panel();
check('missing cost warning', t.includes('Cost missing on 1 card'));
await page.click('.sh-q:has-text("Cost missing")'); await wait(100);
check('filter to cards missing cost', await page.locator('.sh-table tbody tr').count() === 1);
await page.click('.sh-addcost'); await wait(100);
await page.fill('#shCostInput', '25'); await page.click('#shCostSave'); await wait(800);
S = await srv();
check('Add cost saves the item cost', (S.transaction_item_costs || []).some(x => x.transaction_item_id === 'item-missing' && x.cost_at_sale === 25));

// ── Empty show ──
await page.click('.sh-back'); await wait(400);
await page.click('.sh-show-row:has-text("Monster Show")'); await wait(400);
check('empty show: log your first sale or trade', (await panel()).includes('Log your first sale or trade'));

// ── Add a private show ──
await page.click('.sh-back'); await wait(400);
await page.click('.sh-add summary');
await page.fill('#shNewName', 'Church Basement Show'); await page.click('.sh-add-form button'); await wait(600);
S = await srv();
check('private show added', (S.dealer_shows || []).some(x => x.name === 'Church Basement Show' && x.owner_id === 'u1'));

// ── Baseline ──
await page.click('#sellerTabInventory'); await wait(200);
check('Set baseline button on the inventory tab', await page.isVisible('#baselineBtn'));
await page.click('#baselineBtn'); await wait(1500);
S = await srv();
check('baseline snapshot written', S.inventory_snapshots.some(x => x.kind === 'baseline' && x.card_count === 2));
check('growth since baseline strip', (await page.textContent('#baselineStrip')).includes('Since baseline'));

// ── Offline baseline keeps the numbers from when it was taken ──
await setOffline(true);
await page.evaluate(() => shSnapshot('manual', null, null)); await wait(300);
await page.evaluate(() => { const c = inventory.find(x => x._dbId === 'c2'); c.Status = 'Sold'; });   // inventory changes before sync
await setOffline(false); await wait(2000);
S = await srv();
const manual = (S.inventory_snapshots || []).filter(x => x.kind === 'manual');
check('offline snapshot synced once, with the numbers from when it was taken', manual.length === 1 && manual[0].card_count === 2, JSON.stringify(manual));

// ── show_start when Show Mode opens on a show day (once) ──
await page.evaluate(() => { localStorage.removeItem('smExited:tester'); openShowMode('show_a'); }); await wait(1200);
await page.evaluate(() => { closeShowMode(); openShowMode('show_a'); }); await wait(1200);
S = await srv();
check('show_start written once when Show Mode opens on the show day', S.inventory_snapshots.filter(x => x.kind === 'show_start' && x.show_id === 'show_a').length === 1);
await page.evaluate(() => closeShowMode()); await wait(200);

// ── Layout ──
await page.click('#sellerTabShows'); await wait(300);
await page.click('.sh-show-row:has-text("Mall Show")'); await wait(400);
check('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
