// "Use a photo I already have": add a card (or a whole case) from a photo on the device.
//   node photo-upload.e2e.mjs "iPhone 13"     (serve the repo root on :8765 first)
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });   // a fake camera for Take Photo
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block', permissions: ['camera'] });
const today = new Date().toLocaleDateString('en-CA');
await ctx.addInitScript(([today]) => { localStorage.setItem('smExited:tester', 'show_a|' + today); }, [today]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); };
const wait = ms => page.waitForTimeout(ms);
const srv = () => page.evaluate(() => JSON.parse(localStorage.getItem('__srv')));
// Save Add Card and return the new card's server row once its photo has synced.
async function saveAndGetRow(title) {
  await page.fill('#ac_price', '25');
  await page.evaluate(() => saveAddCard());
  await wait(3000);
  const S = await srv();
  return { S, row: S.inventory.find(r => (r.card_title || '').includes(title)) };
}

// A real 40x56 PNG so the browser can decode and resize it.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAA4CAIAAAAASi2hAAAANUlEQVR4nO3NQQkAAAgEsAt2/TGWMQQZ7L9MeyJisVgsFovFYrFYLBaLxWKxWCwWi8XiT/ECn3vwl1+cVlwAAAAASUVORK5CYII=', 'base64');
const file = (name = 'card.png') => ({ name, mimeType: 'image/png', buffer: PNG });

// Playwright tries the most recently added route first, so the catch-all goes first.
await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
let visionCalls = 0, visionMode = 'ok', bulkCalls = 0;
await ctx.route('**/.netlify/functions/vision-scan', r => {
  visionCalls++;
  const body = visionMode === 'ok'
    ? { success: true, card: { player: 'Bobby Witt Jr.', year: 2022, cardSet: 'Topps Chrome', cardNumber: '7', parallel: 'Refractor',
        grader: null, grade: null, sport: 'Baseball', confidence: { player: 'high', year: 'high', cardSet: 'high', cardNumber: 'high', parallel: 'medium' } } }
    : { success: false, error: 'low_confidence' };
  r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
});
await ctx.route('**/functions/v1/bulk-scan', r => { bulkCalls++;
  r.fulfill({ contentType: 'application/json', body: JSON.stringify({ count: 1, cards: [{ id: 'b1', player: 'shohei ohtani', year: '2018',
    set: 'topps', cardNumber: '700', parallel: '', grade: '', grader: '', confidence: 'high', notes: '' }] }) }); });
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));

await page.goto(BASE + '/app.html'); await wait(400);
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(2500);

// ── menu: the new choice and its sub-screen ──
await page.evaluate(() => openQuickActions('add'));
check('Add menu lists "Use a photo I already have"', await page.isVisible('#qaScreenAdd button:has-text("Use a photo I already have")'));
await page.click('#qaScreenAdd button:has-text("Use a photo I already have")');
check('it asks what is in the photo, with Back', (await page.textContent('#qaTitle')).includes('in the photo')
  && await page.isVisible('#qaScreenPhoto') && await page.isVisible('#qaBackBtn'));
check('photo inputs open the library, not the camera',
  await page.evaluate(() => ['cardPhotoLibraryInput', 'bulkScanLibraryInput'].every(id => {
    const el = document.getElementById(id); return el && !el.hasAttribute('capture') && el.accept === 'image/*'; })));

// one card
let chooser = page.waitForEvent('filechooser');
await page.click('#qaScreenPhoto button:has-text("A photo of one card")');
await (await chooser).setFiles(file());
await wait(900);
const filled = await page.evaluate(() => ({ open: document.getElementById('addCardOverlay').classList.contains('open'),
  player: document.getElementById('ac_player').value, year: document.getElementById('ac_year').value,
  set: document.getElementById('ac_set').value, num: document.getElementById('ac_number').value,
  title: document.getElementById('ac_title').value, menu: document.getElementById('qaOverlay').classList.contains('open') }));
check('one card: menu closes, Add Card opens filled from the photo', filled.open && !filled.menu && filled.player === 'Bobby Witt Jr.'
  && String(filled.year) === '2022' && /Topps Chrome/i.test(filled.set) && filled.num === '7' && /Witt/.test(filled.title), JSON.stringify(filled));
check('one card: the card scanner (camera) never opened', await page.evaluate(() => document.getElementById('certScannerOverlay').style.display !== 'flex'));
check('the photo is shown as the card\'s photo before saving', await page.isVisible('#ac_photo_note img')
  && /saved with this card/.test(await page.textContent('#ac_photo_note')));
let saved = await saveAndGetRow('Witt');
let capId = saved.row && saved.row.primary_capture_id;
check('saved: the identify photo is the card\'s photo on the server', capId && saved.S.card_captures.some(c => c.id === capId && c.inventory_id === saved.row.id && c.uploaded_at)
  && saved.S.storage.some(k => k.includes(capId)), JSON.stringify(saved.row));
await page.evaluate(() => { inventory.length = 0; });   // keep the next adds independent

// Remove: the card is saved without a photo
await page.evaluate(() => openQuickActions('photo'));
let ch0 = page.waitForEvent('filechooser');
await page.click('#qaScreenPhoto button:has-text("A photo of one card")');
await (await ch0).setFiles(file());
await wait(900);
await page.click('#ac_photo_note button:has-text("Remove")');
check('Remove drops the photo', !(await page.isVisible('#ac_photo_note')));
const capsBefore = (await srv()).card_captures.length;
saved = await saveAndGetRow('Witt');
check('removed: card saved with no photo', (await srv()).card_captures.length === capsBefore, String(capsBefore));

// closing Add Card without saving drops it too
await page.evaluate(() => openQuickActions('photo'));
ch0 = page.waitForEvent('filechooser');
await page.click('#qaScreenPhoto button:has-text("A photo of one card")');
await (await ch0).setFiles(file());
await wait(900);
await page.evaluate(() => closeAddCard());
await page.evaluate(() => openAddCard());
check('closing without saving drops it', !(await page.isVisible('#ac_photo_note')));
await page.evaluate(() => closeAddCard());

// unreadable photo
visionMode = 'low';
await page.evaluate(() => closeAddCard());
await page.evaluate(() => openQuickActions('photo'));
chooser = page.waitForEvent('filechooser');
await page.click('#qaScreenPhoto button:has-text("A photo of one card")');
await (await chooser).setFiles(file('blurry.png'));
await wait(900);
check('unreadable photo: says so, form stays open for typing', (await page.textContent('#toast')).includes("Couldn't read the card")
  && await page.evaluate(() => document.getElementById('addCardOverlay').classList.contains('open')));
visionMode = 'ok';

// from inside Add Card
chooser = page.waitForEvent('filechooser');
await page.click('#ac_scan_row a:has-text("Use a photo I already have")');
await (await chooser).setFiles(file());
await wait(900);
check('Add Card link: fills the open form', (await page.inputValue('#ac_player')) === 'Bobby Witt Jr.');

// from the card scanner overlay
await page.evaluate(() => { closeAddCard(); openAddCard(); openCertScanner(); });
await wait(200);
check('card scanner shows "Use a photo I already have"', await page.isVisible('#scanLibraryBtn'));
chooser = page.waitForEvent('filechooser');
await page.click('#scanLibraryBtn');
await (await chooser).setFiles(file());
await wait(900);
check('scanner: closes the camera and fills Add Card', await page.evaluate(() => document.getElementById('certScannerOverlay').style.display !== 'flex')
  && (await page.inputValue('#ac_player')) === 'Bobby Witt Jr.');
check('vision called once per photo', visionCalls === 6, String(visionCalls));

// Take Photo with the (fake) camera: the frame becomes the card's photo
await page.evaluate(() => { closeAddCard(); openAddCard(); openCertScanner(); });
await page.waitForFunction(() => document.getElementById('scannerVideo').videoWidth > 0, null, { timeout: 8000 }).catch(() => {});
await page.evaluate(() => scanTakePhoto());
await wait(1200);
check('Take Photo: frame kept as the card\'s photo', await page.isVisible('#ac_photo_note img'));
saved = await saveAndGetRow('Witt');
capId = saved.row && saved.row.primary_capture_id;
check('Take Photo: saved card has that photo on the server', capId && saved.S.card_captures.some(c => c.id === capId && c.uploaded_at), JSON.stringify(saved.row));

// whole case from a saved photo → bulk scan review
await page.evaluate(() => { closeAddCard(); openQuickActions('photo'); });
chooser = page.waitForEvent('filechooser');
await page.click('#qaScreenPhoto button:has-text("A photo of a whole case")');
await (await chooser).setFiles(file('case.png'));
await wait(1500);
check('whole case: runs the case scan and opens the review', bulkCalls === 1
  && await page.evaluate(() => document.getElementById('bulkScanReviewOverlay')?.classList.contains('open')
    || getComputedStyle(document.getElementById('bulkScanReviewOverlay')).display !== 'none'), String(bulkCalls));

check('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
check('no page errors', errors.length === 0, JSON.stringify(errors));
await browser.close();
console.log(fails ? `${fails} FAILED (${deviceName})` : `all passed (${deviceName})`);
process.exit(fails ? 1 : 0);
