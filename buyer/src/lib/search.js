// The search page's URL ↔ search_listings() parameters. Used on the server (rendering /search and
// storefronts) and in the browser (saving a search, opening a saved one). Saved searches store the
// search_listings shape, because saved-search-alerts.js runs them as is.

export const PAGE_SIZE = 24;
export const SORTS = {
  best: 'Best match', newest: 'Newest', price_asc: 'Price: low to high', price_desc: 'Price: high to low',
  deal: 'Best deal (vs market)', distance: 'Nearest',
};
export const CATEGORIES = ['Sports', 'TCG', 'Non-Sport'];
export const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'TAG', 'HGA', 'GMA'];
export const MILES = [25, 50, 100, 250];
export const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY'];

const clean = s => String(s ?? '').trim();
const num = s => { const n = Number(clean(s).replace(/[$,]/g, '')); return clean(s) !== '' && Number.isFinite(n) ? n : null; };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// "This weekend": today through Sunday when it's already Friday–Sunday, else next Friday–Sunday.
export function weekendRange(today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dow = d.getDay(); // 0 Sun … 6 Sat
  const from = new Date(d);
  if (dow >= 1 && dow <= 4) from.setDate(d.getDate() + (5 - dow));
  const to = new Date(d);
  to.setDate(d.getDate() + (dow === 0 ? 0 : 7 - dow));
  return { from: iso(from), to: iso(to) };
}

// URLSearchParams (or a plain object) → { p: search_listings params, form: values for the filter form, page }
export function fromQuery(input, { today = new Date() } = {}) {
  const sp = input instanceof URLSearchParams ? input : new URLSearchParams(input || '');
  const g = k => clean(sp.get(k));
  const p = {}, form = {};
  const q = g('q').slice(0, 200);
  if (q) { p.q = q; form.q = q; }
  if (CATEGORIES.includes(g('category'))) { p.category = g('category'); form.category = g('category'); }
  if (g('subcategory')) { p.subcategory = g('subcategory').slice(0, 60); form.subcategory = p.subcategory; }
  const grader = g('grader').toUpperCase();
  if (GRADERS.includes(grader)) { p.grader = grader; form.grader = grader; }
  if (g('graded') === 'raw') { p.raw = true; form.graded = 'raw'; }
  else if (g('graded') === 'graded') { p.raw = false; form.graded = 'graded'; }
  const min = num(g('min')), max = num(g('max'));
  if (min !== null && min >= 0) { p.price_min_cents = Math.round(min * 100); form.min = String(min); }
  if (max !== null && max > 0) { p.price_max_cents = Math.round(max * 100); form.max = String(max); }
  if (g('deals') === '1') { p.deals_only = true; form.deals = true; }
  if (g('how') === 'ship') { p.sale_mode = 'ship'; form.how = 'ship'; }
  else if (g('how') === 'pickup') { p.sale_mode = 'local_pickup'; form.how = 'pickup'; }
  if (STATES.includes(g('state').toUpperCase())) { p.state = g('state').toUpperCase(); form.state = p.state; }
  if (/^[\w-]{1,80}$/.test(g('show'))) { p.show_id = g('show'); form.show = p.show_id; }
  if (g('when') === 'weekend') {
    const w = weekendRange(today); p.date_from = w.from; p.date_to = w.to; p.when = 'weekend'; form.when = 'weekend';
  } else if (g('when') === 'month') {
    const to = new Date(today); to.setDate(to.getDate() + 30);
    p.date_from = iso(today); p.date_to = iso(to); p.when = 'month'; form.when = 'month';
  }
  // Near a ZIP code or city (loc, resolved by the page with geo.js) or the browser's location (lat/lng).
  // A typed place wins over coordinates. p.near.lat is empty until the page resolves loc.
  const miles = MILES.includes(Number(g('miles'))) ? Number(g('miles')) : 50;
  const loc = g('loc').slice(0, 80);
  const lat = num(g('lat')), lng = num(g('lng'));
  if (loc) {
    p.near = { label: loc, miles };
    form.loc = loc; form.miles = String(miles);
  } else if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    p.near = { lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000, miles };
    form.lat = String(p.near.lat); form.lng = String(p.near.lng); form.miles = String(miles);
  }
  if (/^[\w.-]{1,40}$/.test(g('dealer'))) p.dealer = g('dealer');
  const sort = g('sort');
  if (SORTS[sort] && (sort !== 'distance' || p.near)) { p.sort = sort; form.sort = sort; }
  const page = Math.min(Math.max(parseInt(g('page'), 10) || 1, 1), 200);
  return { p, form, page };
}

// search_listings params → the search page's query string (reverse of fromQuery; used for saved searches).
export function toQuery(p = {}) {
  const sp = new URLSearchParams();
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '') sp.set(k, String(v)); };
  set('q', p.q); set('category', p.category); set('subcategory', p.subcategory); set('grader', p.grader);
  if (p.raw === true) set('graded', 'raw'); else if (p.raw === false) set('graded', 'graded');
  if (p.price_min_cents != null) set('min', p.price_min_cents / 100);
  if (p.price_max_cents != null) set('max', p.price_max_cents / 100);
  if (p.deals_only) set('deals', '1');
  if (p.sale_mode === 'ship') set('how', 'ship'); else if (p.sale_mode === 'local_pickup') set('how', 'pickup');
  set('state', p.state); set('show', p.show_id); set('when', p.when);
  if (p.near?.label) { set('loc', p.near.label); set('miles', p.near.miles); }
  else if (p.near) { set('lat', p.near.lat); set('lng', p.near.lng); set('miles', p.near.miles); }
  set('sort', p.sort);
  return sp.toString();
}

// What a saved search stores: no fixed dates (they'd go stale; `when` is kept so opening the search
// re-applies "this weekend", but alert emails ignore dates), no paging, and no sort (alerts use newest).
export function forSaving(p = {}) {
  const { date_from, date_to, limit, offset, sort, dealer, ...rest } = p;
  return rest;
}

// A short name for a saved search: "charizard · PSA · under $500 · CA"
export function describe(p = {}) {
  const parts = [];
  if (p.q) parts.push(`"${p.q}"`);
  if (p.category) parts.push(p.category);
  if (p.grader) parts.push(p.grader);
  if (p.raw === true) parts.push('Raw');
  if (p.raw === false && !p.grader) parts.push('Graded');
  if (p.price_min_cents != null && p.price_max_cents != null) parts.push(`$${p.price_min_cents / 100}–$${p.price_max_cents / 100}`);
  else if (p.price_max_cents != null) parts.push(`under $${p.price_max_cents / 100}`);
  else if (p.price_min_cents != null) parts.push(`$${p.price_min_cents / 100}+`);
  if (p.deals_only) parts.push('deals');
  if (p.sale_mode === 'ship') parts.push('ships');
  if (p.sale_mode === 'local_pickup') parts.push('pickup');
  if (p.state) parts.push(p.state);
  if (p.near) parts.push(p.near.label ? `within ${p.near.miles} mi of ${p.near.label}` : `within ${p.near.miles} mi`);
  if (p.when === 'weekend') parts.push('this weekend');
  if (p.when === 'month') parts.push('next 30 days');
  return (parts.join(' · ') || 'All listings').slice(0, 120);
}
