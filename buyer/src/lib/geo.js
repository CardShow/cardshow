// "Near 95814" / "Near Sacramento, CA" for the search page. Uses the same Census data as the
// Netlify functions (netlify/lib/us-zips.json, netlify/lib/us-places.json, built by
// scripts/build_us_zips.py and scripts/build_us_places.py), loaded on first use only.
// placeKey() and ALIASES must match netlify/lib/us-places.js.
import { STATES } from './search.js';

let ZIPS = null, PLACES = null;
async function zips() { return ZIPS ??= (await import('../../../netlify/lib/us-zips.json', { with: { type: 'json' } })).default; }
async function places() { return PLACES ??= (await import('../../../netlify/lib/us-places.json', { with: { type: 'json' } })).default; }

const SUFFIX = /\s+(city and borough|consolidated government \(balance\)|metro government \(balance\)|unified government \(balance\)|metropolitan government \(balance\)|\(balance\)|city|town|village|cdp|borough|municipality|comunidad|zona urbana|plantation|corporation|urban county)$/;

export function placeKey(name) {
  let s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  for (let i = 0; i < 2; i++) s = s.replace(SUFFIX, '').trim();
  s = s.replace(/\bsaint\b/g, 'st').replace(/\bsainte\b/g, 'ste').replace(/\bfort\b/g, 'ft').replace(/\bmount\b/g, 'mt');
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}

const ALIASES = {
  'HI|honolulu': 'urban honolulu',
  'NY|nyc': 'new york', 'NY|new york city': 'new york', 'NY|manhattan': 'new york', 'NY|brooklyn': 'new york',
  'NY|queens': 'new york', 'NY|bronx': 'new york', 'NY|staten island': 'new york',
  'DC|washington dc': 'washington', 'DC|dc': 'washington',
};

const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

function inState(map, st, city) {
  const states = map[st];
  if (!states) return null;
  let key = placeKey(city);
  if (!key) return null;
  key = ALIASES[`${st}|${key}`] || key;
  return states[key] || states[key.replace(/^the /, '')] || null;
}

// "Sacramento, CA" / "sacramento ca" / "Sacramento, California" → { city, st }; else { city } only.
function splitCityState(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?)[,\s]+([A-Za-z]{2})\.?$/.exec(t);
  if (m && STATES.includes(m[2].toUpperCase())) return { city: m[1].replace(/,\s*$/, ''), st: m[2].toUpperCase() };
  const lower = t.toLowerCase();
  for (const [name, st] of Object.entries(STATE_NAMES)) {
    if (lower.endsWith(' ' + name) || lower.endsWith(',' + name)) {
      const city = t.slice(0, t.length - name.length).replace(/[,\s]+$/, '');
      if (city) return { city, st };
    }
  }
  return { city: t.replace(/,\s*$/, '') };
}

const titleCase = s => s.replace(/\S+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());

// → { ok: true, lat, lng, label } or { ok: false, error: 'empty'|'not_found'|'need_state', states? }
export async function resolveLocation(input) {
  const text = String(input ?? '').trim().slice(0, 80);
  if (!text) return { ok: false, error: 'empty' };
  const zip = /^(\d{5})(?:-\d{4})?$/.exec(text);
  if (zip) {
    const hit = (await zips())[zip[1]];
    return hit ? { ok: true, lat: hit[0], lng: hit[1], label: zip[1] } : { ok: false, error: 'not_found' };
  }
  if (/^\d+$/.test(text)) return { ok: false, error: 'not_found' };
  const map = await places();
  const { city, st } = splitCityState(text);
  if (st) {
    const hit = inState(map, st, city);
    return hit ? { ok: true, lat: hit[0], lng: hit[1], label: `${titleCase(city)}, ${st}` } : { ok: false, error: 'not_found' };
  }
  // No state: use the city when only one state has it.
  const found = STATES.filter(s => inState(map, s, city));
  if (found.length === 1) {
    const hit = inState(map, found[0], city);
    return { ok: true, lat: hit[0], lng: hit[1], label: `${titleCase(city)}, ${found[0]}` };
  }
  if (found.length > 1) return { ok: false, error: 'need_state', states: found.slice(0, 6) };
  return { ok: false, error: 'not_found' };
}

export function locationMessage(text, r) {
  if (r.error === 'need_state') return `“${text}” is in more than one state. Add the state, like “${titleCase(text)}, ${r.states[0]}”.`;
  return `We couldn’t find “${text}”. Try a 5-digit ZIP code or a city and state, like “Sacramento, CA”.`;
}
