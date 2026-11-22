// ZIP / city lookup for "near" searches (src/lib/geo.js).   npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocation, locationMessage } from '../src/lib/geo.js';
import { fromQuery, toQuery, describe } from '../src/lib/search.js';

test('ZIP codes', async () => {
  const r = await resolveLocation('95814');
  assert.ok(r.ok); assert.equal(r.label, '95814');
  assert.ok(Math.abs(r.lat - 38.58) < 0.05 && Math.abs(r.lng + 121.49) < 0.05);
  assert.equal((await resolveLocation('95814-1234')).label, '95814');
  assert.equal((await resolveLocation('00000')).error, 'not_found');
  assert.equal((await resolveLocation('1234')).error, 'not_found');
});

test('city and state, typed several ways', async () => {
  for (const t of ['Sacramento, CA', 'sacramento ca', 'Sacramento, California', 'SACRAMENTO,CA']) {
    const r = await resolveLocation(t);
    assert.ok(r.ok, t); assert.equal(r.label, 'Sacramento, CA');
  }
  assert.equal((await resolveLocation('Saint Louis, MO')).ok, true);
  assert.equal((await resolveLocation('Brooklyn, NY')).ok, true);
  assert.equal((await resolveLocation('Nowhereville, CA')).error, 'not_found');
});

test('city without a state', async () => {
  const one = await resolveLocation('anaheim');
  assert.ok(one.ok); assert.equal(one.label, 'Anaheim, CA');
  const many = await resolveLocation('Springfield');
  assert.equal(many.error, 'need_state'); assert.ok(many.states.length > 1);
  assert.match(locationMessage('springfield', many), /Add the state, like “Springfield, /);
  assert.equal((await resolveLocation('')).error, 'empty');
});

test('loc in the URL', () => {
  const { p, form } = fromQuery('loc=95814&miles=100&lat=1&lng=2&sort=distance');
  assert.deepEqual(p.near, { label: '95814', miles: 100 });
  assert.equal(form.loc, '95814'); assert.equal(form.lat, undefined); assert.equal(p.sort, 'distance');
  const resolved = { ...p, near: { lat: 38.581, lng: -121.496, miles: 100, label: '95814' } };
  assert.equal(new URLSearchParams(toQuery(resolved)).get('loc'), '95814');
  assert.equal(describe(resolved), 'within 100 mi of 95814');
});
