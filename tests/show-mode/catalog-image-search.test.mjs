// netlify/functions/catalog-image-search.js with CardSight stubbed. Run: node catalog-image-search.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const ID = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const calls = [];
let mode = 'ok';
global.fetch = async (url, opts) => {
  calls.push({ url: String(url), key: opts.headers['X-API-Key'] });
  if (mode === 'limit') return { ok: false, status: 429, json: async () => ({}) };
  const u = new URL(url);
  if (u.searchParams.get('number')) return { ok: true, status: 200, json: async () => ({ cards: [
    { id: ID(1), name: 'Elly De La Cruz', releaseName: 'Topps Chrome', releaseYear: 2023, number: '2' }] }) };
  if (u.searchParams.get('releaseName')) return { ok: false, status: 500, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ cards: [
    { id: ID(2), name: 'Elly De La Cruz', releaseName: 'Bowman', releaseYear: 2023, number: 'BP-9' },
    { id: ID(1), name: 'Elly De La Cruz', releaseName: 'Topps Chrome', releaseYear: 2023, number: '2' },
    { id: 'not-a-uuid', name: 'Bad row' },
    { id: ID(3), name: 'Elly De La Cruz', releaseName: 'Topps Chrome', setName: 'Refractor', releaseYear: 2023, number: '2' }] }) };
};
process.env.CARDSIGHT_API_KEY = 'test-key';
const { handler } = require('../../netlify/functions/catalog-image-search.js');
const call = async body => JSON.parse((await handler({ httpMethod: 'POST', body: JSON.stringify(body) })).body);

let r = await call({ player: 'Elly De La Cruz', year: '2023', cardSet: '2023 Topps Chrome', cardNumber: '#2' });
check('success with results', r.success && r.results.length === 3, JSON.stringify(r));
check('deduped, bad ids dropped', new Set(r.results.map(x => x.id)).size === r.results.length && !r.results.some(x => x.id === 'not-a-uuid'));
check('exact number + release ranked first; other release last', r.results[0].number === '2' && r.results[2].id === ID(2));
check('image goes through card-image', r.results[0].imageUrl === '/.netlify/functions/card-image?id=' + r.results[0].id);
check('set name added to the title', r.results.some(x => /Topps Chrome Refractor/.test(x.title)));
check('three attempts: number, release (500 skipped), name+year', calls.length === 3 && /number=2/.test(calls[0].url) && /releaseName=Topps\+Chrome/.test(calls[1].url) && calls.every(c => c.key === 'test-key'), JSON.stringify(calls.map(c => c.url)));
r = await call({ year: '2023' });
check('player required', !r.success && r.error === 'player_required');
mode = 'limit'; calls.length = 0;
r = await call({ player: 'X' });
check('rate limit reported, stops', !r.success && r.error === 'cardsight_http_429' && calls.length === 1);
delete process.env.CARDSIGHT_API_KEY;
r = await call({ player: 'X' });
check('no key', !r.success && r.error === 'missing_key');
console.log(fails ? `${fails} FAILED` : 'all passed');
