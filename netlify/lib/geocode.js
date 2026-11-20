// Show geocoding with US Census data (Marketplace Phase 1: "cards at shows within X miles").
//   1. Street address → Census Geocoder (geocoding.geo.census.gov, free, no key, US only).
//   2. No street address, or no match → the city's point from the Census Gazetteer (us-places.js).
// The Census Geocoder only matches street addresses: "Sacramento, CA" or "Cal Expo, Sacramento, CA"
// return nothing, so shows without a street address go straight to the city point.

const { lookupPlace } = require('./us-places');

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

async function censusAddress(address, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const url = `${CENSUS_URL}?${new URLSearchParams({ address, benchmark: 'Public_AR_Current', format: 'json' })}`;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ok: false, error: err?.name === 'TimeoutError' ? 'census_timeout' : 'census_network_error' };
  }
  if (!res.ok) return { ok: false, error: `census_http_${res.status}` };
  let body;
  try { body = await res.json(); } catch { return { ok: false, error: 'census_bad_json' }; }
  const m = body?.result?.addressMatches?.[0];
  const x = Number(m?.coordinates?.x), y = Number(m?.coordinates?.y);
  if (!m || !Number.isFinite(x) || !Number.isFinite(y)) return { ok: true, match: null };
  return { ok: true, match: { lat: y, lng: x, matched: m.matchedAddress || null } };
}

// show: { street_address, city, state, postal_code }
// → { latitude, longitude, geo_source, geo_query, geo_error } (latitude null when nothing matched).
async function geocodeShow(show, opts = {}) {
  const street = String(show.street_address || '').trim();
  const city = String(show.city || '').trim();
  const state = String(show.state || '').trim().toUpperCase();
  const zip = String(show.postal_code || '').trim();
  let censusError = null;
  if (street) {
    const q = [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const r = await censusAddress(q, opts);
    if (r.ok && r.match) {
      return { latitude: r.match.lat, longitude: r.match.lng, geo_source: 'census_address', geo_query: q, geo_error: null };
    }
    censusError = r.ok ? 'address_not_found' : r.error;
    // Census unreachable: don't settle for the city center, try the address again next run.
    if (!r.ok) return { latitude: null, longitude: null, geo_source: null, geo_query: q, geo_error: censusError };
  }
  const p = city && state ? lookupPlace(city, state) : null;
  if (p) {
    return { latitude: p.lat, longitude: p.lng, geo_source: 'census_place', geo_query: `${city}, ${state}`,
             geo_error: censusError };
  }
  return { latitude: null, longitude: null, geo_source: 'not_found',
           geo_query: [street, city, state].filter(Boolean).join(', ') || null,
           geo_error: censusError || (city && state ? 'place_not_found' : 'missing_city_or_state') };
}

module.exports = { geocodeShow, censusAddress };
