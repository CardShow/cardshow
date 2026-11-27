// The photo link page (photo-link.html) at phone size, with /.netlify/functions/photo-link faked in the browser.
//   cd tests/show-mode && node photo-link.e2e.mjs
import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'photo-link.html'), 'utf8');
let failed = 0;
const check = (n, c) => { console.log(c ? 'PASS ' : 'FAIL ', n); if (!c) failed++; };
// A real 20x28 JPEG made by the browser itself
const browser = await chromium.launch();
for (const dev of ['iPhone 13', 'Pixel 7']) {
  const ctx = await browser.newContext({ ...devices[dev] });
  const calls = [];
  let cards = [{ id: 'c1', title: '2020 Bowman Chrome Prospects Anthony Volpe Mojo Refractor', stock_code: 'R-12', has_photo: false }];
  let photos = 0, sent = false;
  await ctx.route('https://getcardshow.com/photo/**', r => r.fulfill({ contentType: 'text/html', body: html }));
  await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('**/.netlify/functions/photo-link', async r => {
    const b = JSON.parse(r.request().postData()); calls.push(b);
    const kind = b.code === 'SCANAAAAAA' ? 'scan' : b.code === 'GONEAAAAAA' ? 'gone' : 'attach';
    if (kind === 'gone') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'attach', expired: true }) });
    if (b.action === 'info') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ kind, expired: false, cards, photos, finished: sent }) });
    if (b.action === 'upload') { photos++; return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, photos }) }); }
    if (b.action === 'done') { sent = true; return r.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); }
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const jpg = Buffer.from(await (await ctx.newPage()).evaluate(() => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 560; c.getContext('2d').fillRect(0, 0, 400, 560);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }), 'base64');
  await page.goto('https://getcardshow.com/photo/ABCDEFGHJK');
  await page.waitForSelector('#stAttach:not([hidden])');
  check(`${dev}: attach page lists the new card`, (await page.textContent('#cardList')).includes('Anthony Volpe'));
  await page.setInputFiles('#cardList input[type=file]', { name: 'card.jpg', mimeType: 'image/jpeg', buffer: jpg });
  await page.waitForFunction(() => document.querySelector('#cardList .state')?.textContent === 'Photo added');
  const up = calls.find(c => c.action === 'upload');
  check(`${dev}: photo resized to JPEG and sent for that card`, up?.card_id === 'c1' && Buffer.from(up.image_base64, 'base64')[0] === 0xff);
  check(`${dev}: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  photos = 0;
  await page.goto('https://getcardshow.com/photo/SCANAAAAAA');
  await page.waitForSelector('#stScan:not([hidden])');
  check(`${dev}: scan page: Send disabled until a photo is added`, await page.isDisabled('#sendBtn'));
  await page.setInputFiles('#scanInput', [{ name: 'a.jpg', mimeType: 'image/jpeg', buffer: jpg }, { name: 'b.jpg', mimeType: 'image/jpeg', buffer: jpg }]);
  await page.waitForFunction(() => document.querySelectorAll('#scanGrid img').length === 2);
  check(`${dev}: two photos uploaded, count shown`, /2 photos ready/.test(await page.textContent('#msg')) && !(await page.isDisabled('#sendBtn')));
  await page.click('#sendBtn');
  await page.waitForSelector('#stSent:not([hidden])');
  check(`${dev}: Send to Claude → done screen`, calls.some(c => c.action === 'done'));
  await page.goto('https://getcardshow.com/photo/GONEAAAAAA');
  await page.waitForSelector('#stGone:not([hidden])');
  check(`${dev}: expired link explained`, (await page.textContent('#stGone')).includes('30 minutes'));
  await page.goto('https://getcardshow.com/photo/short');
  await page.waitForSelector('#stGone:not([hidden])');
  check(`${dev}: bad code: not found`, (await page.textContent('#goneTitle')) === 'Link not found');
  check(`${dev}: no script errors`, errors.length === 0);
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
