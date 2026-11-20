// US place lookup from the Census Gazetteer (netlify/lib/us-places.json, built by
// scripts/build_us_places.py). One point per city/town/CDP: the Census internal point, roughly the
// center. Used by geocode-shows.js when a show has no street address, and by the MCP server's
// "near a city" search. Keep placeKey() in sync with place_key() in the build script.

let PLACES = null;
function places() {
  if (!PLACES) PLACES = require('./us-places.json');
  return PLACES;
}

const SUFFIX = /\s+(city and borough|consolidated government \(balance\)|metro government \(balance\)|unified government \(balance\)|metropolitan government \(balance\)|\(balance\)|city|town|village|cdp|borough|municipality|comunidad|zona urbana|plantation|corporation|urban county)$/;

function placeKey(name) {
  let s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  for (let i = 0; i < 2; i++) s = s.replace(SUFFIX, '').trim();
  s = s.replace(/\bsaint\b/g, 'st').replace(/\bsainte\b/g, 'ste').replace(/\bfort\b/g, 'ft').replace(/\bmount\b/g, 'mt');
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}

// Common names the Census lists differently.
const ALIASES = {
  'HI|honolulu': 'urban honolulu',
  'NY|nyc': 'new york', 'NY|new york city': 'new york', 'NY|manhattan': 'new york', 'NY|brooklyn': 'new york',
  'NY|queens': 'new york', 'NY|bronx': 'new york', 'NY|staten island': 'new york',
  'DC|washington dc': 'washington', 'DC|dc': 'washington',
};

// { lat, lng, key } or null. state is a 2-letter code.
function lookupPlace(city, state) {
  const st = String(state || '').trim().toUpperCase();
  const map = places()[st];
  if (!map) return null;
  let key = placeKey(city);
  if (!key) return null;
  key = ALIASES[`${st}|${key}`] || key;
  let hit = map[key];
  if (!hit) {
    // "St Louis" typed as "Saint Louis" is handled by placeKey; also try without a leading "the".
    const alt = key.replace(/^the /, '');
    hit = map[alt];
    if (hit) key = alt;
  }
  return hit ? { lat: hit[0], lng: hit[1], key } : null;
}

module.exports = { placeKey, lookupPlace };
