// Show geocoding: netlify/lib/us-places.js, netlify/lib/geocode.js, netlify/functions/geocode-shows.js,
// and the MCP server's "near a city". Census stubbed; LIVE=1 also calls the real Census Geocoder.
//   node show-geocoding.test.mjs        (npm install at the repo root first)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { lookupPlace, placeKey } = require('../../netlify/lib/us-places.js');
const { geocodeShow, censusAddress } = require('../../netlify/lib/geocode.js');
const GEO = require('../../netlify/functions/geocode-shows.js')._test;
const MCP = require('../../netlify/functions/mcp.js')._test;

let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const near = (a, lat, lng) => a && Math.abs(a.lat - lat) < 0.05 && Math.abs(a.lng - lng) < 0.05;

// ── places ──
check('placeKey strips type words and normalizes', placeKey('Sacramento city') === 'sacramento' && placeKey('Saint Louis') === 'st louis'
  && placeKey('Fort Worth') === 'ft worth' && placeKey('Louisville/Jefferson County metro government (balance)') === 'louisville jefferson county');
check('city lookup', near(lookupPlace('Sacramento', 'ca'), 38.57, -121.47) && near(lookupPlace('Anaheim', 'CA'), 33.86, -117.76));
check('Saint / Fort / accents / aliases', near(lookupPlace('Saint Louis', 'MO'), 38.64, -90.24) && near(lookupPlace('Fort Worth', 'TX'), 32.78, -97.35)
  && !!lookupPlace('San José', 'CA') && !!lookupPlace('Honolulu', 'HI') && !!lookupPlace('NYC', 'NY'));
check('same name, other state', lookupPlace('Sacramento', 'KY').lat < 38 && lookupPlace('Sacramento', 'KY').lng > -90);
check('unknown place / bad state', lookupPlace('Nowhereville', 'CA') === null && lookupPlace('Sacramento', 'XX') === null);

// ── geocodeShow with Census stubbed ──
let calls = [];
const census = (matches, status = 200) => async (url) => {
  calls.push(String(url));
  if (status !== 200) return new Response('x', { status });
  return new Response(JSON.stringify({ result: { addressMatches: matches } }), { status: 200 });
};
const MATCH = [{ coordinates: { x: -121.4343, y: 38.5954 }, matchedAddress: '1600 EXPOSITION BLVD, SACRAMENTO, CA, 95815' }];
calls = [];
let r = await geocodeShow({ street_address: '1600 Exposition Blvd', city: 'Sacramento', state: 'ca', postal_code: '95815' }, { fetchImpl: census(MATCH) });
check('street address → Census point', r.geo_source === 'census_address' && r.latitude === 38.5954 && r.longitude === -121.4343
  && /address=1600\+Exposition\+Blvd%2C\+Sacramento%2C\+CA\+95815/.test(calls[0]) && /benchmark=Public_AR_Current/.test(calls[0]), calls[0]);
r = await geocodeShow({ street_address: '1 Nowhere Rd', city: 'Sacramento', state: 'CA' }, { fetchImpl: census([]) });
check('address not found → city center, noted', r.geo_source === 'census_place' && near({ lat: r.latitude, lng: r.longitude }, 38.57, -121.47) && r.geo_error === 'address_not_found');
calls = [];
r = await geocodeShow({ city: 'Anaheim', state: 'CA' }, { fetchImpl: census(MATCH) });
check('no street address → city center, no Census call', r.geo_source === 'census_place' && calls.length === 0);
r = await geocodeShow({ street_address: '1600 Exposition Blvd', city: 'Sacramento', state: 'CA' }, { fetchImpl: census([], 503) });
check('Census down → nothing saved, retried later', r.geo_source === null && r.latitude === null && r.geo_error === 'census_http_503');
r = await geocodeShow({ city: 'Atlantis', state: 'CA' }, { fetchImpl: census([]) });
check('unknown city → not_found', r.geo_source === 'not_found' && r.geo_error === 'place_not_found');

// ── geocode-shows function (fake service DB) ──
function fakeDb(rows) {
  const updates = [];
  const q = {
    _single: null,
    select() { return this; }, is() { return this; }, not() { return this; }, or() { return this; }, order() { return this; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
    eq(_c, v) { this._single = v; return this; },
    maybeSingle() { return Promise.resolve({ data: rows.find(x => x.id === this._single) || null, error: null }); },
  };
  return {
    updates,
    from() {
      return {
        select: (...a) => Object.assign(Object.create(q), { _single: null }).select(...a),
        update: (row) => ({ eq: (_c, id) => { updates.push({ id, ...row }); return Promise.resolve({ error: null }); } }),
      };
    },
  };
}
let db = fakeDb([
  { id: 's1', street_address: '1600 Exposition Blvd', city: 'Sacramento', state: 'CA' },
  { id: 's2', city: 'Anaheim', state: 'CA' },
  { id: 's3', city: 'Atlantis', state: 'CA' },
]);
let out = await GEO.runBatch(db, { fetchImpl: census(MATCH) });
check('batch: address, place, not found all saved', out.address === 1 && out.place === 1 && out.not_found === 1 && db.updates.length === 3
  && db.updates.every(u => u.geocoded_at), JSON.stringify(out));
db = fakeDb([{ id: 's1', street_address: '1600 Exposition Blvd', city: 'Sacramento', state: 'CA' }]);
out = await GEO.runBatch(db, { fetchImpl: census([], 500) });
check('batch: Census down leaves the show for the next run', out.retry === 1 && db.updates.length === 0);
db = fakeDb([{ id: 's2', city: 'Anaheim', state: 'CA' }]);
let res = await GEO.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ show_id: 's2' }) }, { db, skipAuth: true, fetchImpl: census([]) });
check('POST one show (Directory save)', res.statusCode === 200 && JSON.parse(res.body).geo_source === 'census_place' && db.updates.length === 1);
res = await GEO.handler({ httpMethod: 'POST', headers: {}, body: '{}' }, { db, skipAuth: true });
check('POST needs show_id', res.statusCode === 400);
res = await GEO.handler({ httpMethod: 'POST', headers: {}, body: '{"show_id":"s2"}' }, { db: { auth: { getUser: async () => ({ data: null, error: { message: 'x' } }) } } });
check('POST without an admin session refused', res.statusCode === 403);

// ── MCP near a city ──
process.env.MARKETPLACE_MCP_ENABLED = 'true';
const seen = [];
const data = { rpc: async (name, args) => { seen.push([name, args]); return { data: name === 'list_upcoming_shows' ? [] : { total: 0, offset: 0, results: [] } }; } };
const svc = { rpc: async () => ({ data: { allowed: true } }), from: () => ({ insert: async () => ({ error: null }) }) };
const call = (name, args) => MCP.handle({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '1.1.1.1' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }, { data, svc });
await call('search_cards', { query: 'charizard', near: { city: 'Anaheim', state: 'CA', miles: 30 } });
const p = seen.pop()[1].p;
check('search_cards near a city → lat/lng sent to search', near(p.near, 33.86, -117.76) && p.near.miles === 30, JSON.stringify(p.near));
await call('list_upcoming_shows', { near: { city: 'Fort Worth', state: 'TX' } });
check('list_upcoming_shows near a city', near(seen.pop()[1].p.near, 32.78, -97.35));
res = JSON.parse((await call('search_cards', { near: { city: 'Atlantis', state: 'CA' } })).body);
check('unknown city → tool error, no search', res.result.isError === true && /Couldn't find Atlantis/.test(res.result.content[0].text));
await call('search_cards', { near: { lat: 40, lng: -74 } });
check('lat/lng still works', JSON.stringify(seen.pop()[1].p.near) === '{"lat":40,"lng":-74}');

// ── live Census (optional) ──
if (process.env.LIVE === '1') {
  const live = await censusAddress('1600 Exposition Blvd, Sacramento, CA');
  check('LIVE Census geocoder: Cal Expo address', live.ok && near(live.match, 38.595, -121.434), JSON.stringify(live));
  const none = await censusAddress('Sacramento, CA');
  check('LIVE Census geocoder: city alone has no match', none.ok && none.match === null);
}

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
