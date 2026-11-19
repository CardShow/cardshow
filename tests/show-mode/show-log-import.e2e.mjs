// Show log import (Trades + Show Home, Phase 3: js/show-log-import.js). Run like the others:
//   node show-log-import.e2e.mjs "iPhone 13"
// Synthetic log and cards. The database side (import_show_log) is checked by show-log-import.test.sh.
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
const today = new Date().toLocaleDateString('en-CA');
await ctx.addInitScript(([today]) => {
  localStorage.setItem('smExited:tester', 'show_a|' + today);   // start in the classic view
  window.confirm = () => true;
}, [today]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const wait = ms => page.waitForTimeout(ms);
const srv = () => page.evaluate(() => JSON.parse(localStorage.getItem('__srv')));
const ov = () => page.textContent('#imOverlay');
const row = n => `#imOverlay .im-row:has(.im-inc:has-text("Row ${n}"))`;

await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));

await page.goto(BASE + '/app.html');
await wait(400);
await page.evaluate((today) => {
  const S = window.__srv;
  const card = (id, code, title, price, extra) => Object.assign({ id, seller_id: 'u1', card_title: title, price, status: 'Available', stock_code: code }, extra || {});
  S.inventory = [
    card('c1', 'S-1', 'Test slab one', 120, { grader: 'PSA', grade: 10 }),
    card('c2', 'R-1', 'Test single one', 40),
    card('c3', 'R-2', 'Test single two', 10),
    card('c4', 'S-2', 'Test slab two', 200, { grader: 'PSA', grade: 9 }),
    card('c5', 'R-3', 'Test single three', 30),
    card('c6', 'R-4', 'Test single four', 25),
    card('c7', 'S-3', 'Test slab sold', 90, { status: 'Sold' }),
  ];
  S.show_inventory = [];
  S.__showList = [{ show_id: null, dealer_show_id: 'ds-mall', name: 'Mall Show', start_date: today, end_date: today, kind: 'private', cards_out: 0, net_pl: 0, missing_cost: 0 }];
  S.__reports = { 'ds-mall': { cards_out: 1, net_pl: 10, wins: 1, losses: 0, even: 0, in_cards: 0, mix: {}, unbalanced: [], ungrouped_txn_ids: [],
    rows: [{ code: 'S-9', title: 'Earlier sale', cost: 10, value: 20, profit: 10, result: 'Win', type: 'sale', txn_id: 'x', item_id: 'y' }],
    unbalanced_trades: 0, ungrouped_cards: 0, needs_review: 0, cards_missing_cost: 0 } };
  S.dealer_transactions = []; S.transaction_items = []; S.inventory_costs = [];
  localStorage.setItem('__srv', JSON.stringify(S));
}, today);
await page.reload(); await wait(400);
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(2500);

// ── Parsing helpers ──
const u = await page.evaluate(() => ({
  d1: imDate('2026-11-07'), d2: imDate('11/7/2026'), d3: imDate('11/7/26'), d4: imDate('Nov 7, 2026'), d5: imDate('Nov 7', 2026), d6: imDate('7 Nov 2026'), d7: imDate('13/45/2026'),
  t1: imTime('2:15 PM'), t2: imTime('14:15'), t3: imTime('2pm'), t4: imTime('25:00'),
  c1: _imCodeOf('S12'), c2: _imCodeOf('Slab 12'), c3: _imCodeOf('S-12'), c4: _imCodeOf('single 4'), c5: _imCodeOf('R4'), c6: _imCodeOf('Charizard'),
  i1: imParseInCard('S-67: Charizard PSA 9'), i2: imParseInCard('R2-D2 Funko'), i3: imParseInCard('Slab 40 Mahomes BGS 9.5'),
  ty: [imType('SOLD'), imType('Trade'), imType('BUY'), imType('bought'), imType('swap')],
  csv: imParseTable('Date,Type,Cards Out,Cards In\n11/7,TRADE,"S1, S2","Luka, PSA 9 (gem)"\n'),
  md: imParseTable('| Date | Type |\n|---|---|\n| 11/7 | SOLD |'),
  tsv: imParseTable('Date\tType\n11/7\tBUY'),
  split: imSplitIn('Luka PSA 9, Mahomes RC; Wemby (Silver, /99)'),
}));
check('dates: ISO, M/D/Y, M/D/YY, "Nov 7, 2026", "Nov 7", "7 Nov 2026"', [u.d1, u.d2, u.d3, u.d4, u.d5, u.d6].every(x => x === '2026-11-07') && u.d7 === null, JSON.stringify([u.d1, u.d2, u.d3, u.d4, u.d5, u.d6, u.d7]));
check('times: 2:15 PM, 14:15, 2pm; 25:00 refused', u.t1.h === 14 && u.t1.m === 15 && u.t2.h === 14 && u.t3.h === 14 && u.t4 === null);
check('stock codes: S12, Slab 12, S-12, single 4, R4; not a title', u.c1 === 'S-12' && u.c2 === 'S-12' && u.c3 === 'S-12' && u.c4 === 'R-4' && u.c5 === 'R-4' && u.c6 === null);
check('card in with a code: "S-67: Charizard PSA 9"', u.i1.code === 'S-67' && u.i1.title === 'Charizard PSA 9' && u.i1.grader === 'PSA' && u.i1.grade === '9');
check('"R2-D2 Funko" is a title, not code R-2', u.i2.code === null && u.i2.title === 'R2-D2 Funko');
check('"Slab 40 Mahomes BGS 9.5"', u.i3.code === 'S-40' && u.i3.title === 'Mahomes BGS 9.5' && u.i3.grade === '9.5');
check('types: SOLD / TRADE / BUY / bought; swap unknown', JSON.stringify(u.ty) === JSON.stringify(['sale', 'trade', 'buy', 'buy', null]));
check('CSV with quoted commas', u.csv.length === 2 && u.csv[1][2] === 'S1, S2' && u.csv[1][3] === 'Luka, PSA 9 (gem)');
check('Markdown and tab-separated tables', u.md.length === 2 && u.md[1][1] === 'SOLD' && u.tsv[1][1] === 'BUY');
check('cards in split on commas, not inside brackets', JSON.stringify(u.split) === JSON.stringify(['Luka PSA 9', 'Mahomes RC', 'Wemby (Silver, /99)']));

// ── Open from Show Home ──
await page.click('#sellerTabShows'); await wait(400);
await page.click('.sh-show-row:has-text("Mall Show")'); await wait(400);
check('Show Home has "Import show log"', await page.isVisible('button:has-text("Import show log")'));
await page.click('button:has-text("Import show log")'); await wait(200);
check('import screen opens', (await ov()).includes('Cards Out'));

const log = `Here's your log:

| Date | Time | Type | Cards Out | Cards In | Cash In | Cash Out | Payment Method | Notes |
|---|---|---|---|---|---|---|---|---|
| ${today} | 10:00 AM | SOLD | S1 | | $130 | | Cash | |
| ${today} | 10:15 AM | SOLD | Single 1, Single 2 | | 50 | | Venmo | lot |
| ${today} | 10:30 AM | TRADE | Slab 2 | Luka Doncic PSA 9 | 20 | | | |
| ${today} | 10:45 AM | TRADE | S-99 | Wemby RC, S-40: Mahomes PSA 10 | | | | |
| ${today} | 11:00 AM | BUY | | Charizard PSA 8 | | 150 | Cash | |
| ${today} | 11:15 AM | SOLD | R3 | | 35 | | Card | |
| ${today} | 11:20 AM | SWAP | S-3 | | | | | |
| ${today} | 11:30 AM | TRADE | S-40 | Topps Chrome Auto | | | | chained |`;
await page.fill('#imPaste', log);
await page.click('button:has-text("Read log")'); await wait(600);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
let t = await ov();
check('review: 8 rows', await page.locator('#imOverlay .im-row').count() === 8, String(await page.locator('#imOverlay .im-row').count()));
check('unknown code is an error, not skipped', (await page.textContent(row(4))).includes("S-99 isn't in your inventory"));
check('bad type and a sold card are errors', (await page.textContent(row(7))).includes('Unknown type "SWAP"') && (await page.textContent(row(7))).includes('S-3 is already sold'));
check('import blocked while rows need fixing', await page.isDisabled('#imImportBtn') && t.includes('to fix'));
check('lot split estimated (amber), by asking price 40/10', await page.locator(`${row(2)} .im-val.im-est`).count() === 2
  && await page.inputValue(`${row(2)} [data-f="outVal-0"]`) === '40' && await page.inputValue(`${row(2)} [data-f="outVal-1"]`) === '10');
check('1-for-1 trade: out = asking 200, in = 200 − 20 received = 180, balanced', await page.inputValue(`${row(3)} [data-f="outVal-0"]`) === '200'
  && await page.inputValue(`${row(3)} [data-f="inVal-0"]`) === '180' && (await page.textContent(`${row(3)} [data-balance]`)).includes('balanced'));
check('multi-card trade values left for the dealer (red)', await page.locator(`${row(4)} .im-val.im-field-bad`).count() >= 2);
check('chained trade: S-40 came in earlier in this log', (await page.textContent(row(8))).includes('Came in earlier in this log'));
check('buy: price paid = cash out', await page.inputValue(`${row(5)} [data-f="inVal-0"]`) === '150');

// Fix row 4: the code, then values (unbalanced first, then balanced).
await page.fill(`${row(4)} .im-code`, 'Single 4'); await page.press(`${row(4)} .im-code`, 'Tab'); await wait(100);
check('code fixed: R-4 matched', (await page.textContent(row(4))).includes('Test single four'));
await page.fill(`${row(4)} [data-f="outVal-0"]`, '25');
await page.fill(`${row(4)} [data-f="inVal-0"]`, '20');
await page.fill(`${row(4)} [data-f="inVal-1"]`, '10'); await wait(100);
check('unbalanced trade warns but doesn\'t block', (await page.textContent(`${row(4)} [data-balance]`)).includes('$5 unaccounted') && (await page.textContent(`${row(4)} .im-pill`)).includes('Check'));
await page.fill(`${row(4)} [data-f="inVal-1"]`, '5'); await wait(100);
check('balanced after the fix', (await page.textContent(`${row(4)} [data-balance]`)).includes('balanced'));
await page.fill(`${row(8)} [data-f="outVal-0"]`, '260');
await page.fill(`${row(8)} [data-f="inVal-0"]`, '260');
await page.uncheck(`${row(7)} .im-inc input`); await wait(100);
check('row 7 left out; import ready', !(await page.isDisabled('#imImportBtn')) && (await page.textContent('#imImportBtn')).includes('Import 7'), await page.textContent('#imImportBtn'));

await page.click('#imImportBtn'); await wait(1500);
let S = await srv();
const call = await page.evaluate(() => window.__mockLog.filter(x => x.op === 'import_show_log').pop());
const p = call && call.payload.p_txns;
check('one import call, 7 rows, private show', p && p.length === 7 && call.payload.p_dealer_show_id === 'ds-mall' && call.payload.p_show_id === null);
const by = k => p.find(x => x.local_time === k);
check('sale: 1 card, $130, observed value', by('10:00 AM').txn_type === 'sale' && by('10:00 AM').out[0].inventory_id === 'c1' && by('10:00 AM').out[0].value === 130 && by('10:00 AM').cash_in === 130);
check('two cards sold together → lot_sale', by('10:15 AM').txn_type === 'lot_sale' && by('10:15 AM').out.length === 2 && by('10:15 AM').payment_method === 'Venmo');
check('trade with cash received', by('10:30 AM').txn_type === 'trade' && by('10:30 AM').cash_in === 20 && by('10:30 AM').in[0].value === 180 && by('10:30 AM').in[0].grader === 'PSA' && by('10:30 AM').in[0].grade === '9');
check('card in keeps its own code (S-40)', by('10:45 AM').in[1].stock_code === 'S-40' && by('10:45 AM').in[1].title === 'Mahomes PSA 10');
check('buy: cash paid 150, no cards out', by('11:00 AM').txn_type === 'buy' && by('11:00 AM').cash_out === 150 && by('11:00 AM').out.length === 0 && by('11:00 AM').in[0].value === 150);
check('chained trade sends a ref to the earlier card', by('11:30 AM').out[0].ref === by('10:45 AM').in[1].ref);
check('import keys unique', new Set(p.map(x => x.key)).size === 7 && p.every(x => /^log:[0-9a-f]{32}$/.test(x.key)));
check('local date and time sent', p.every(x => x.local_date === today));
check('cards out marked sold; 5 new cards need details', S.inventory.filter(r => ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].includes(r.id)).every(r => r.status === 'Sold')
  && S.inventory.filter(r => r.identification_status === 'unidentified').length === 5);
check('overlay closed, back on Show Home', !(await page.isVisible('#imOverlay')) && (await page.textContent('#showHomePanel')).includes('Mall Show'));
check('Show Home flags the new cards', (await page.textContent('#showHomePanel')).includes('4 imported cards need details'), (await page.textContent('#showHomePanel')).replace(/\s+/g, ' ').slice(0, 300));

// Same log again: nothing new.
await page.click('button:has-text("Import show log")'); await wait(200);
await page.fill('#imPaste', log);
await page.click('button:has-text("Read log")'); await wait(600);
check('same log again: 7 rows already imported', await page.locator('#imOverlay .im-row--dup').count() === 7);
check('only the bad row left, and it blocks', await page.isDisabled('#imImportBtn'));
await page.uncheck(`${row(7)} .im-inc input`); await wait(100);
check('nothing to import', (await page.textContent('#imImportBtn')).includes('Import 0') && await page.isDisabled('#imImportBtn'));
await page.click('#imOverlay .im-x');

// A CSV file.
await page.click('button:has-text("Import show log")'); await wait(200);
await page.setInputFiles('#imFile', { name: 'log.csv', mimeType: 'text/csv',
  buffer: Buffer.from(`Date,Time,Type,Cards Out,Cards In,Cash In,Cash Out,Payment Method,Notes\n${today},1:00 PM,BUY,,"Pikachu, holo",,12,Cash,\n`) });
await wait(600);
check('CSV file read: a buy whose "Cards In" has a comma becomes 2 cards, values left for the dealer',
  await page.locator('#imOverlay .im-row').count() === 1 && await page.locator(`${row(1)} .im-in-title`).count() === 2
  && await page.inputValue(`${row(1)} [data-f="inVal-0"]`) === '' && await page.isDisabled('#imImportBtn'));
await page.click(`${row(1)} .im-card:has([data-f="inTitle-1"]) .sh-link`); await wait(100);
check('after removing the extra card, the price is still needed', await page.isDisabled('#imImportBtn'));
await page.fill(`${row(1)} [data-f="inTitle-0"]`, 'Pikachu holo'); await page.fill(`${row(1)} [data-f="inVal-0"]`, '12'); await wait(100);
check('then it can be imported', !(await page.isDisabled('#imImportBtn')));
await page.click('#imOverlay .im-x');

// Inventory: "needs details" chip and search; Edit Card → Save clears it.
await page.click('#sellerTabInventory'); await wait(300);
check('Needs details chip on imported cards', await page.locator('.im-needs-chip').count() === 4, String(await page.locator('.im-needs-chip').count()));
await page.fill('#sellerSearchInput', 'needs details'); await page.evaluate(() => applyInventoryFilters()); await wait(200);
const titles = await page.evaluate(() => [...document.querySelectorAll('.card-title')].map(x => x.textContent));
check('search "needs details" lists them', titles.length === 4 && titles.every(x => x.includes('Needs details')), JSON.stringify(titles));
await page.evaluate(() => { const c = inventory.find(x => x['Card Title'] === 'Wemby RC'); openCEM(inventory.indexOf(c)); }); await wait(300);
await page.evaluate(() => saveCEM()); await wait(500);
S = await srv();
check('Edit Card → Save marks it identified', S.inventory.find(r => r.card_title === 'Wemby RC').identification_status === null
  && await page.evaluate(() => imNeedsCards().length) === 3);
check('cards needing details aren\'t published by Add My Cards', await page.evaluate(() => {
  sellerPublishToShow('show_a');
  return inventory.filter(c => c.IdentificationStatus === 'unidentified').every(c => !c._shows.has('show_a'))
    && inventory.find(c => c['Card Title'] === 'Wemby RC')._shows.has('show_a');
}));

check('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
