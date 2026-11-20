// netlify/functions/catalog-image-search.js with CardSight stubbed. Run: node catalog-image-search.test.mjs
// Scenarios are modeled on real misses (2026-11-20): an insert autograph that matched the base card,
// an autograph whose number is stored differently, and a base card next to inserts of the same player.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const ID = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

// Fake catalog. Each row: CardSight catalog shape.
const CATALOG = [
  // Trish Stratus, 2023 Revolution WWE: base, an insert, and the Cubic Autograph
  { id: ID(1), name: 'Trish Stratus', releaseName: 'Revolution WWE', releaseYear: 2023, number: '112' },
  { id: ID(2), name: 'Trish Stratus', releaseName: 'Revolution WWE', setName: 'Star Gazing', releaseYear: 2023, number: 'SG-4' },
  { id: ID(3), name: 'Trish Stratus', releaseName: 'Revolution WWE', setName: 'Cubic Autographs', releaseYear: 2023, number: 'CA-TS', attributes: [{ shortName: 'AU' }] },
  { id: ID(4), name: 'Trish Stratus', releaseName: 'Chronicles WWE', releaseYear: 2023, number: '121' },
  // Cam Skattebo, 2025 Topps Chrome Black: catalog stores the auto number without the prefix
  { id: ID(5), name: 'Cam Skattebo', releaseName: 'Topps Chrome Black', setName: 'Autographs', releaseYear: 2025, number: 'CSK', attributes: ['AU'] },
  { id: ID(6), name: 'Cam Skattebo', releaseName: 'Topps Chrome', releaseYear: 2025, number: '201' },
  // Dylan Crews, 2024 Bowman Chrome: base #BCP-1, an insert, and a different year
  { id: ID(7), name: 'Dylan Crews', releaseName: 'Bowman Chrome', releaseYear: 2024, number: 'BCP-1' },
  { id: ID(8), name: 'Dylan Crews', releaseName: 'Bowman Chrome', setName: 'Rookie Of The Year Favorites', releaseYear: 2024, number: 'ROYF-3' },
  { id: ID(9), name: 'Dylan Crews', releaseName: 'Bowman Chrome', releaseYear: 2023, number: 'BCP-1' },
  { id: 'not-a-uuid', name: 'Dylan Crews', releaseYear: 2024 },
];
const calls = [];
let mode = 'ok';
global.fetch = async (url, opts) => {
  const u = new URL(url);
  calls.push({ url: String(url), key: opts.headers['X-API-Key'] });
  if (mode === 'limit') return { ok: false, status: 429, json: async () => ({}) };
  const p = Object.fromEntries(u.searchParams);
  if (p.attributeShortName && mode === 'au500') return { ok: false, status: 500, json: async () => ({}) };
  const rows = CATALOG.filter(c => (!p.name || String(c.name).toLowerCase().includes(p.name.toLowerCase()))
    && (!p.year || String(c.releaseYear) === p.year)
    && (!p.number || c.number === p.number)
    && (!p.releaseName || String(c.releaseName || '').toLowerCase().includes(p.releaseName.toLowerCase()))
    && (!p.attributeShortName || JSON.stringify(c.attributes || []).includes(p.attributeShortName)))
    .slice(0, Number(p.take || 25));
  return { ok: true, status: 200, json: async () => ({ cards: rows }) };
};
process.env.CARDSIGHT_API_KEY = 'test-key';
const { handler, _test } = require('../../netlify/functions/catalog-image-search.js');
const call = async body => JSON.parse((await handler({ httpMethod: 'POST', body: JSON.stringify(body) })).body);
const ids = list => (list || []).map(r => r.id);

// Helpers
check('set name → release ("Panini" dropped, year dropped)', _test.setRelease('2023 Panini Revolution WWE') === 'Revolution WWE');
check('number variants: prefix and dash', JSON.stringify(_test.numberVariants('RAU-CSK')) === '["RAU-CSK","RAUCSK","CSK"]');
check('number variants: no bare numeric tail', JSON.stringify(_test.numberVariants('ROOKIE-02')) === '["ROOKIE-02","ROOKIE02"]');

// 1. Insert autograph: only the Cubic Autograph is an exact match
let r = await call({ player: 'Trish Stratus', year: '2023', cardSet: 'Panini Revolution WWE', title: '2023 Panini Revolution WWE Trish Stratus Cubic Autograph /49' });
check('insert auto: exact match is the Cubic Autograph only', JSON.stringify(ids(r.results)) === JSON.stringify([ID(3)]), JSON.stringify(r.results));
check('insert auto: base #112 and Star Gazing are in "others", not results', ids(r.others).includes(ID(1)) && ids(r.others).includes(ID(2)));
check('insert auto: autograph flag on the result', r.results[0] && r.results[0].auto === true);

// 2. Autograph whose catalog number has no prefix
calls.length = 0;
r = await call({ player: 'Cam Skattebo', year: '2025', cardSet: 'Topps Chrome Black', cardNumber: 'RAU-CSK', parallel: 'Autograph', title: '2025 Topps Chrome Black Cam Skattebo Autograph' });
check('auto with prefixed number: finds the CSK autograph', JSON.stringify(ids(r.results)) === JSON.stringify([ID(5)]), JSON.stringify(r.results));
check('auto: non-auto Topps Chrome #201 is not a match', !ids(r.results).includes(ID(6)));
check('auto: release search asks for AU', calls.some(c => /attributeShortName=AU/.test(c.url) && /releaseName=Topps\+Chrome\+Black/.test(c.url)), JSON.stringify(calls.map(c => c.url)));
check('auto: manufacturer sent with the release search', calls.some(c => /manufacturer=Topps/.test(c.url)));
check('at most 5 CardSight calls', calls.length <= 5 && calls.every(c => c.key === 'test-key'));

// 3. Base card: inserts and other years never count as a match
calls.length = 0;
r = await call({ player: 'Dylan Crews', year: '2024', cardSet: '2024 Bowman Chrome', cardNumber: 'BCP-1', title: '2024 Bowman Chrome Dylan Crews' });
check('base card: exact match is the 2024 base #BCP-1', JSON.stringify(ids(r.results)) === JSON.stringify([ID(7)]), JSON.stringify(r.results));
check('base card: insert of the same year is in "others"', ids(r.others).includes(ID(8)));
check('base card: other years left out entirely', !ids(r.results).concat(ids(r.others)).includes(ID(9)));
check('bad ids dropped', !ids(r.results).concat(ids(r.others)).includes('not-a-uuid'));
check('number found: second number variant not searched', calls.filter(c => /number=/.test(c.url)).length === 1);
check('image goes through card-image', r.results[0].imageUrl === '/.netlify/functions/card-image?id=' + ID(7));

// 4. Nothing exact: no results, other cards only
r = await call({ player: 'Shohei Ohtani', year: '2018', cardSet: 'Leaf NSC', cardNumber: 'ROOKIE-02' });
check('no exact match: empty results', r.success && r.results.length === 0);

// 5. AU filter erroring doesn't break the search
mode = 'au500';
r = await call({ player: 'Trish Stratus', year: '2023', cardSet: 'Panini Revolution WWE', parallel: 'Cubic Autograph' });
check('AU search 500: still finds the Cubic Autograph', ids(r.results).includes(ID(3)), JSON.stringify(r));
mode = 'ok';

// 6. Debug, errors
r = await call({ player: 'Trish Stratus', year: '2023', cardSet: 'Panini Revolution WWE', title: 'Cubic Autograph', debug: true });
check('debug lists what was searched', r.debug && r.debug.release === 'Revolution WWE' && r.debug.isAuto && r.debug.insertWords.includes('cubic') && r.debug.attempts.length > 0, JSON.stringify(r.debug));
r = await call({ year: '2023' });
check('player required', !r.success && r.error === 'player_required');
mode = 'limit'; calls.length = 0;
r = await call({ player: 'X' });
check('rate limit reported, stops', !r.success && r.error === 'cardsight_http_429' && calls.length === 1);
mode = 'ok';
delete process.env.CARDSIGHT_API_KEY;
r = await call({ player: 'X' });
check('no key', !r.success && r.error === 'missing_key');
console.log(fails ? `${fails} FAILED` : 'all passed');
