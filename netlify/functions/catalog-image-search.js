// netlify/functions/catalog-image-search.js
// POST { player, year, cardSet, cardNumber, parallel, title, features[] } → CardSight catalog cards
// that could be this card, as candidate stock images for Edit Card's "Use a catalog image".
// See CLAUDE.md "Card photos". Raw cards only: the app never offers this for a graded card, whose
// photo must show the exact slab (buyers match the cert number).
//
// Response: { success, results: [...], others: [...] }, each { id, title, year, release, number,
//   imageUrl, auto }. results = exact matches only; others = other cards of the same player and year
//   that did NOT match (shown separately, labeled as not a match). Max 8 + 6.
// A catalog card is an exact match when:
//   - the year matches (when the card has one), and
//   - the card number matches (also tried without the prefix / dashes) or the release matches, and
//   - an autograph matches an autograph (attribute AU, or "auto"/"signature" in its set name), and
//   - insert or parallel words from the card ("Cubic", "Star Gazing") appear in its set name; a card with
//     none of those words doesn't match an insert set.
// CardSight catalog search: GET https://api.cardsight.ai/v1/catalog/cards with name=, year=, number=,
// releaseName= (partial), manufacturer=, attributeShortName= (AU), take= (see comp-lookup.js). number= is
// sent on its own, as in comp-lookup.js. Uses CARDSIGHT_API_KEY and its monthly quota (at most 5 calls).
// extractReleaseName() / inferManufacturer() are copied from comp-lookup.js (no shared module); keep in sync.

const BASE = 'https://api.cardsight.ai/v1/catalog/cards';
const TIMEOUT_MS = 4000;
const MAX_CALLS = 5;
const MAX_RESULTS = 8;
const MAX_OTHERS = 6;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
const clean = v => String(v == null ? '' : v).trim();
const alnum = v => clean(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const words = v => clean(v).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

function extractReleaseName(cardSet) {
  const s = (cardSet || '').toLowerCase().replace(/^\d{4}[-\s]*/, '');
  const signatures = [
    // Topps Chrome variants — most specific first
    ['topps chrome update sapphire', 'Topps Chrome Update Sapphire Edition'],
    ['chrome update sapphire',       'Topps Chrome Update Sapphire Edition'],
    ['topps chrome update',          'Topps Chrome Update'],
    ['chrome update',                'Topps Chrome Update'],
    // Bowman Chrome before bare Bowman
    ['bowman chrome draft',          'Bowman Chrome Draft'],
    ['bowman chrome',                'Bowman Chrome'],
    ['topps chrome',                 'Topps Chrome'],
    ['chrome',                       'Topps Chrome'],  // fallback for bare "Chrome"
    // Bowman variants
    ['bowman platinum',              'Bowman Platinum'],
    ['bowman sterling',              'Bowman Sterling'],
    ["bowman's best",                "Bowman's Best"],
    ['bowman',                       'Bowman'],
    // Prizm variants
    ['prizm draft picks',            'Prizm Draft Picks'],
    ['prizm draft',                  'Prizm Draft'],
    ['panini prizm',                 'Prizm'],
    ['prizm',                        'Prizm'],
    // Other Panini
    ['donruss optic',                'Donruss Optic'],
    ['panini contenders optic',      'Panini Contenders Optic'],
    ['panini contenders',            'Panini Contenders'],
    ['select',                       'Select'],
    ['donruss',                      'Donruss'],
    ['panini chronicles',            'Chronicles'],
    // Topps product lines
    ['topps update',                 'Topps Update'],
    ['topps series 2',               'Topps Series 2'],
    ['topps series 1',               'Topps Series 1'],
    ['topps heritage',               'Topps Heritage'],
    ['topps finest',                 'Topps Finest'],
    ['topps stadium club',           'Stadium Club'],
    ['topps pro debut',              'Topps Pro Debut'],
    ['topps',                        'Topps'],
    // Other
    ['upper deck',                   'Upper Deck'],
    ['fleer ultra',                  'Fleer Ultra'],
    ['fleer',                        'Fleer'],
    ['score',                        'Score'],
  ];
  for (const [key, val] of signatures) {
    if (s.includes(key)) return val;
  }
  const words = s.split(/\s+/).filter(w => w.length > 3);
  return words[0] ? words[0].charAt(0).toUpperCase() + words[0].slice(1) : null;
}

// Map card set to manufacturer for catalog search narrowing.
// Prevents Topps cards from matching Panini results and vice versa.

function inferManufacturer(cardSet) {
  const s = (cardSet || '').toLowerCase();
  if (s.includes('topps') || s.includes('bowman')) return 'Topps';
  if (s.includes('panini') || s.includes('prizm') || s.includes('donruss') ||
      s.includes('select') || s.includes('mosaic') || s.includes('contenders') ||
      s.includes('chronicles') || s.includes('optic'))
    return 'Panini';
  if (s.includes('upper deck') || s.includes(' ud ')) return 'Upper Deck';
  if (s.includes('fleer')) return 'Fleer';
  return null;
}

function setRelease(cardSet) {
  const s = clean(cardSet).replace(/^\d{4}(-\d{2,4})?\s+/, '').replace(/^panini\s+/i, '').replace(/\s+/g, ' ').trim();
  return s || clean(extractReleaseName(cardSet) || '');
}

// "RAU-CSK" → ["RAU-CSK", "RAUCSK", "CSK"]; "#112" → ["112"].
function numberVariants(n) {
  const raw = clean(n).replace(/^#/, '');
  if (!raw) return [];
  const out = [raw];
  if (/[-\s]/.test(raw)) {
    out.push(raw.replace(/[-\s]/g, ''));
    const tail = raw.split(/[-\s]/).pop();
    if (tail && tail.length >= 2 && /[a-z]/i.test(tail)) out.push(tail);   // "CSK", never a bare "02"
  }
  return [...new Set(out)];
}

const AUTO_RE = /\b(auto|autos|autograph|autographs|autographed|signed|signature|signatures|au)\b/i;
const STOP = new Set(['base', 'card', 'cards', 'the', 'and', 'of', 'rc', 'rookie', 'rookies', 'rated', 'auto', 'autos',
  'autograph', 'autographs', 'autographed', 'signed', 'signature', 'signatures', 'au', 'psa', 'bgs', 'bvg', 'sgc',
  'cgc', 'tag', 'hga', 'gma', 'csg', 'ags', 'isa', 'raw', 'gem', 'mint', 'nm', 'near', 'graded', 'slab',
  'panini', 'topps', 'bowman', 'upper', 'deck', 'donruss', 'leaf', 'fleer', 'chrome', 'variation', 'parallel', 'numbered', 'ssp', 'sp']);

function attrCodes(c) {
  const list = Array.isArray(c && c.attributes) ? c.attributes : [];
  return list.map(a => clean(typeof a === 'string' ? a : (a && (a.shortName || a.short_name || a.code || a.name)))).filter(Boolean);
}

// Words that name an insert or parallel ("cubic", "star gazing"), from the card's parallel and title,
// minus the player, year, set, number and generic words.
function insertWords(card) {
  const drop = new Set([...words(card.player), ...words(card.cardSet), ...words(card.release),
    ...words(card.manufacturer), ...words(card.cardNumber)]);
  const src = [card.parallel, card.title].map(clean).join(' ').replace(/\/\s*\d+/g, ' ');
  return [...new Set(words(src).filter(w => w.length > 2 && !/^\d+$/.test(w) && !STOP.has(w) && !drop.has(w)))];
}

function toCandidate(c) {
  const id = c && (c.id || c.uuid || c.card_id);
  if (!id || !ID_RE.test(String(id))) return null;
  const year = clean(c.releaseYear || c.year || (c.release && c.release.year));
  const release = clean(c.releaseName || (c.release && c.release.name));
  const setName = clean(c.setName || (c.set && c.set.name));
  const insert = setName && !/^base( set)?$/i.test(setName) ? setName : '';
  const setPart = insert && !release.toLowerCase().includes(insert.toLowerCase()) ? ` ${insert}` : '';
  const number = clean(c.number);
  const name = clean(c.name);
  const attrs = attrCodes(c);
  return {
    id: String(id), year, release: release + setPart, number, name, insert,
    auto: attrs.some(a => /^au$/i.test(a) || AUTO_RE.test(a)) || AUTO_RE.test(insert),
    title: [year, release + setPart, name, number ? '#' + number : ''].filter(Boolean).join(' '),
    imageUrl: '/.netlify/functions/card-image?id=' + encodeURIComponent(String(id)),
  };
}

// { strong, score } for one catalog card.
function judge(c, card) {
  const yearOk = !card.year || !c.year || c.year === card.year;
  const nums = numberVariants(card.cardNumber).map(alnum);
  const cn = alnum(c.number);
  const numOk = !!cn && nums.includes(cn);
  const relWords = words(card.release).filter(w => w.length > 2 && w !== 'the' && w !== 'and');
  const candRel = c.release.toLowerCase();
  const releaseOk = relWords.length > 0 && relWords.every(w => candRel.includes(w));
  const text = (c.release + ' ' + c.insert + ' ' + c.name).toLowerCase();
  const hits = card.insertWords.filter(w => text.includes(w)).length;
  const insertOk = card.insertWords.length ? hits > 0 : !c.insert || card.isAuto;
  const autoOk = card.isAuto ? c.auto : !c.auto;
  const strong = yearOk && (numOk || releaseOk) && insertOk && autoOk;
  const score = (numOk ? 10 : 0) + (releaseOk ? 5 : 0) + hits * 2 + (card.isAuto && c.auto ? 2 : 0) + (yearOk ? 1 : 0);
  return { strong, yearOk, score };
}

async function search(params, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}?${params}`, { headers: { 'X-API-Key': key }, signal: controller.signal });
    if (res.status === 401 || res.status === 429) return { stop: res.status };
    if (!res.ok) { console.warn('[catalog-image-search] CardSight', res.status, String(params)); return { rows: [] }; }
    const data = await res.json();
    return { rows: data?.cards || data?.data || [] };
  } catch (e) {
    console.warn('[catalog-image-search]', e.name === 'AbortError' ? 'timeout' : e.message);
    return { rows: [] };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'method_not_allowed' });
  const key = process.env.CARDSIGHT_API_KEY;
  if (!key) return json(200, { success: false, error: 'missing_key' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { success: false, error: 'parse_error' }); }
  const card = {
    player: clean(body.player).slice(0, 80),
    year: (clean(body.year).match(/\d{4}/) || [''])[0],
    cardSet: clean(body.cardSet).slice(0, 120),
    cardNumber: clean(body.cardNumber).slice(0, 40),
    parallel: clean(body.parallel).slice(0, 120),
    title: clean(body.title).slice(0, 200),
  };
  if (!card.player) return json(200, { success: false, error: 'player_required' });
  const features = Array.isArray(body.features) ? body.features.map(clean) : [];
  // Release to search and match on: the set name without its year or a leading "Panini" (CardSight names
  // Panini releases without it: "Revolution WWE"). extractReleaseName()'s table is a fallback for its
  // short names, e.g. "Prizm" for "Panini Prizm".
  card.release = setRelease(card.cardSet);
  card.manufacturer = card.cardSet ? (inferManufacturer(card.cardSet) || '') : '';
  card.isAuto = features.some(f => /^auto$/i.test(f)) || AUTO_RE.test(card.parallel) || AUTO_RE.test(card.title);
  card.insertWords = insertWords(card);

  const base = () => { const p = new URLSearchParams(); p.set('name', card.player); if (card.year) p.set('year', card.year); return p; };
  const plan = [];
  numberVariants(card.cardNumber).slice(0, 2).forEach((n, i) => {
    const p = base(); p.set('number', n); p.set('take', '8'); plan.push({ kind: 'number', p, onlyIfEmpty: i > 0 });
  });
  if (card.release) {
    if (card.isAuto) {
      const p = base(); p.set('releaseName', card.release); p.set('attributeShortName', 'AU');
      if (card.manufacturer) p.set('manufacturer', card.manufacturer);
      p.set('take', '15'); plan.push({ kind: 'release_au', p });
    }
    const p = base(); p.set('releaseName', card.release);
    if (card.manufacturer) p.set('manufacturer', card.manufacturer);
    p.set('take', '20'); plan.push({ kind: 'release', p });
  }
  { const p = base(); p.set('take', '25'); plan.push({ kind: 'player_year', p }); }

  const seen = new Map();
  const attemptsLog = [];
  let calls = 0, numberHits = 0;
  for (const step of plan) {
    if (calls >= MAX_CALLS) break;
    if (step.onlyIfEmpty && numberHits) continue;
    const strongSoFar = [...seen.values()].filter(x => x.j.strong).length;
    if (strongSoFar >= 4) break;
    calls++;
    const r = await search(step.p, key);
    if (r.stop) {
      if (!seen.size) return json(200, { success: false, error: `cardsight_http_${r.stop}` });
      break;
    }
    if (step.kind === 'number') numberHits += r.rows.length;
    attemptsLog.push({ kind: step.kind, count: r.rows.length });
    for (const row of r.rows) {
      const c = toCandidate(row);
      if (c && !seen.has(c.id)) seen.set(c.id, { c, j: judge(c, card) });
    }
  }

  const all = [...seen.values()].sort((a, b) => b.j.score - a.j.score);
  const strip = ({ c }) => ({ id: c.id, title: c.title, year: c.year, release: c.release, number: c.number, imageUrl: c.imageUrl, auto: c.auto });
  const out = {
    success: true,
    results: all.filter(x => x.j.strong).slice(0, MAX_RESULTS).map(strip),
    others: all.filter(x => !x.j.strong && x.j.yearOk).slice(0, MAX_OTHERS).map(strip),
  };
  if (body.debug) out.debug = { release: card.release, manufacturer: card.manufacturer, isAuto: card.isAuto, insertWords: card.insertWords, attempts: attemptsLog };
  return json(200, out);
};

exports._test = { setRelease, extractReleaseName, inferManufacturer, numberVariants, insertWords, toCandidate, judge };
