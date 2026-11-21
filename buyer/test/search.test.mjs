// URL ↔ search_listings params (src/lib/search.js).   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromQuery, toQuery, forSaving, describe, weekendRange } from '../src/lib/search.js';

test('filters map to search_listings params', () => {
  const { p, page } = fromQuery('q=charizard+psa&category=TCG&grader=psa&graded=graded&min=100&max=2%2C500&deals=1&how=pickup&state=ca&sort=price_asc&page=3');
  assert.deepEqual(p, { q: 'charizard psa', category: 'TCG', grader: 'PSA', raw: false, price_min_cents: 10000, price_max_cents: 250000,
    deals_only: true, sale_mode: 'local_pickup', state: 'CA', sort: 'price_asc' });
  assert.equal(page, 3);
});

test('junk is dropped', () => {
  const { p, page } = fromQuery('category=Cars&grader=XYZ&min=abc&state=ZZ&sort=distance&show=a%20b&page=-4&lat=200&lng=5');
  assert.deepEqual(p, {});
  assert.equal(page, 1);
});

test('near me needs both coordinates; distance sort only with a location', () => {
  const { p } = fromQuery('lat=38.59541&lng=-121.43431&miles=100&sort=distance');
  assert.deepEqual(p.near, { lat: 38.595, lng: -121.434, miles: 100 });
  assert.equal(p.sort, 'distance');
  assert.equal(fromQuery('lat=38.5&lng=-121.4&miles=7').p.near.miles, 50);
});

test('this weekend', () => {
  assert.deepEqual(weekendRange(new Date(2026, 10, 18)), { from: '2026-11-20', to: '2026-11-22' }); // Wed
  assert.deepEqual(weekendRange(new Date(2026, 10, 21)), { from: '2026-11-21', to: '2026-11-22' }); // Sat
  assert.deepEqual(weekendRange(new Date(2026, 10, 22)), { from: '2026-11-22', to: '2026-11-22' }); // Sun
  const { p } = fromQuery('when=weekend', { today: new Date(2026, 10, 18) });
  assert.equal(p.date_from, '2026-11-20'); assert.equal(p.date_to, '2026-11-22'); assert.equal(p.when, 'weekend');
});

test('round trip and saving', () => {
  const q = 'q=wemby&category=Sports&graded=raw&max=50&deals=1&how=ship&state=TX&when=weekend&lat=32.7&lng=-96.8&miles=25&sort=newest';
  const { p } = fromQuery(q);
  assert.deepEqual(fromQuery(toQuery(p)).p, p);
  const saved = forSaving(p);
  assert.equal(saved.date_from, undefined); assert.equal(saved.sort, undefined); assert.equal(saved.when, 'weekend');
  assert.equal(describe(saved), '"wemby" · Sports · Raw · under $50 · deals · ships · TX · within 25 mi · this weekend');
  assert.equal(describe({}), 'All listings');
});
