// netlify/functions/catalog-image-search.js
// POST { player, year, cardSet, cardNumber, parallel } → CardSight catalog cards that match a
// card's details, as candidate stock images for Edit Card's "Use a catalog image".
// See CLAUDE.md "Card photos". Raw cards only: the app never offers this for a graded card,
// whose photo must show the exact slab (buyers match the cert number).
//
// Response: { success, results: [{ id, title, year, release, number, imageUrl }] } (max 8).
// imageUrl goes through card-image.js (CDN-cached). Some catalog cards have no image; the
// app hides tiles whose image fails to load.
//
// CardSight catalog search: GET https://api.cardsight.ai/v1/catalog/cards with name=, year=,
// number=, releaseName= (partial), take= (see comp-lookup.js). number= is sent on its own,
// as in comp-lookup.js, because combining it with releaseName= causes 500s. Uses
// CARDSIGHT_API_KEY and its monthly quota (at most 3 calls per search).

const BASE = 'https://api.cardsight.ai/v1/catalog/cards';
const TIMEOUT_MS = 4500;
const MAX_RESULTS = 8;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
const clean = v => String(v == null ? '' : v).trim();
const normNum = v => clean(v).replace(/^#/, '').toLowerCase();

// "2023 Panini Prizm" → "Panini Prizm" (CardSight matches releaseName partially).
function releaseFrom(cardSet) {
  return clean(cardSet).replace(/^\d{4}(-\d{2,4})?\s+/, '').replace(/\s+/g, ' ');
}

function attempts(card) {
  const base = () => {
    const p = new URLSearchParams();
    p.set('name', card.player);
    if (card.year) p.set('year', card.year);
    return p;
  };
  const out = [];
  if (card.cardNumber && card.cardNumber.length > 0) {
    const p = base(); p.set('number', card.cardNumber.replace(/^#/, '')); p.set('take', '8'); out.push(p);
  }
  const release = releaseFrom(card.cardSet);
  if (release) { const p = base(); p.set('releaseName', release); p.set('take', '15'); out.push(p); }
  { const p = base(); p.set('take', '20'); out.push(p); }
  return out;
}

function toResult(c) {
  const id = c && (c.id || c.uuid || c.card_id);
  if (!id || !ID_RE.test(String(id))) return null;
  const year = clean(c.releaseYear || c.year);
  const release = clean(c.releaseName || c.release?.name);
  const setName = clean(c.setName || c.set?.name);
  const setPart = setName && !/^base( set)?$/i.test(setName) && !release.toLowerCase().includes(setName.toLowerCase())
    ? ` ${setName}` : '';
  const number = clean(c.number);
  return {
    id: String(id),
    title: [year, release + setPart, clean(c.name), number ? '#' + number : ''].filter(Boolean).join(' '),
    year, release: release + setPart, number,
    imageUrl: '/.netlify/functions/card-image?id=' + encodeURIComponent(String(id)),
  };
}

// Same card number and year first, then same release words.
function rank(results, card) {
  const num = normNum(card.cardNumber);
  const relWords = releaseFrom(card.cardSet).toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const score = r => (num && normNum(r.number) === num ? 10 : 0)
    + (card.year && r.year === card.year ? 4 : 0)
    + relWords.filter(w => r.release.toLowerCase().includes(w)).length;
  return results.map((r, i) => ({ r, s: score(r), i })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.r);
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
  };
  if (!card.player) return json(200, { success: false, error: 'player_required' });

  const seen = new Map();
  for (const params of attempts(card)) {
    if (seen.size >= MAX_RESULTS) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}?${params}`, { headers: { 'X-API-Key': key }, signal: controller.signal });
      if (res.status === 401 || res.status === 429) {
        console.warn('[catalog-image-search] CardSight', res.status);
        if (!seen.size) return json(200, { success: false, error: `cardsight_http_${res.status}` });
        break;
      }
      if (!res.ok) { console.warn('[catalog-image-search] CardSight', res.status, String(params)); continue; }
      const data = await res.json();
      const rows = data?.cards || data?.data || [];
      for (const row of rows) {
        const r = toResult(row);
        if (r && !seen.has(r.id)) seen.set(r.id, r);
      }
    } catch (e) {
      console.warn('[catalog-image-search]', e.name === 'AbortError' ? 'timeout' : e.message);
    } finally {
      clearTimeout(timer);
    }
  }
  return json(200, { success: true, results: rank([...seen.values()], card).slice(0, MAX_RESULTS) });
};
