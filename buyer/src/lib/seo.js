// robots.txt and sitemap.xml for getcardshow.com. The buyer site makes both; the main site proxies
// /robots.txt and /sitemap.xml to it (repo _redirects), so one robots.txt covers the whole domain.
// Before launch (BUYER_SITE_INDEXING not "true") crawlers are kept off the marketplace pages and no
// sitemap is advertised; the main site's own pages (landing page, show.html, privacy) stay crawlable as before.

// Never useful to a search engine, before or after launch.
const PRIVATE = ['/app', '/app.html', '/account', '/.netlify/', '/mcp', '/trade-board', '/seller-browse'];
const MARKETPLACE = ['/search', '/shows', '/c/', '/d/', '/s/'];

export function buildRobots({ indexing, site }) {
  const lines = ['# getcardshow.com', 'User-agent: *', 'Allow: /'];
  for (const p of PRIVATE) lines.push(`Disallow: ${p}`);
  if (!indexing) {
    lines.push('# Marketplace pages open to crawlers at launch (BUYER_SITE_INDEXING=true).');
    for (const p of MARKETPLACE) lines.push(`Disallow: ${p}`);
  }
  lines.push('');
  if (indexing) lines.push(`Sitemap: ${site}/sitemap.xml`, '');
  return lines.join('\n');
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const day = iso => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || '')); return m ? m[1] : null; };

// entries: [{ loc (absolute), lastmod? 'YYYY-MM-DD' }]
export function buildSitemap(entries) {
  const seen = new Set();
  const urls = entries.filter(e => e && e.loc && !seen.has(e.loc) && seen.add(e.loc)).map(e =>
    `  <url><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${esc(e.lastmod)}</lastmod>` : ''}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

// search_listings returns at most 50 per call and offsets up to 5,000, so this covers the newest 5,050
// listings. Past that, add a database function that returns just ids, slugs and dates.
export const SITEMAP_MAX_LISTINGS = 5050;
const PAGE = 50;

export async function collectSitemap({ rpc, site, today = new Date().toISOString().slice(0, 10) }) {
  const first = await rpc('search_listings', { p: { sort: 'newest', limit: PAGE, offset: 0 } });
  const total = Math.min(first?.total || 0, SITEMAP_MAX_LISTINGS);
  const offsets = [];
  for (let o = PAGE; o < total; o += PAGE) offsets.push(o);
  const pages = [first?.results || []];
  for (let i = 0; i < offsets.length; i += 8) {          // 8 calls at a time
    const batch = await Promise.all(offsets.slice(i, i + 8).map(o =>
      rpc('search_listings', { p: { sort: 'newest', limit: PAGE, offset: o } }).then(r => r?.results || [])));
    pages.push(...batch);
  }
  const listings = pages.flat();
  let shows = [];
  try { shows = await rpc('list_upcoming_shows', { p: { limit: 50 } }) || []; } catch { /* listings still go out */ }

  const dealers = new Map();
  for (const l of listings) {
    const url = l?.dealer?.url, d = day(l?.listed_at);
    if (url && l.dealer.handle && (!dealers.has(url) || (d && d > dealers.get(url)))) dealers.set(url, d);
  }
  const newest = listings.map(l => day(l?.listed_at)).filter(Boolean).sort().pop() || today;
  return [
    { loc: `${site}/` },
    { loc: `${site}/search`, lastmod: newest },
    { loc: `${site}/shows` },
    ...listings.filter(l => l?.url).map(l => ({ loc: site + l.url, lastmod: day(l.listed_at) })),
    ...[...dealers].map(([url, d]) => ({ loc: site + url, lastmod: d })),
    ...(Array.isArray(shows) ? shows : []).filter(s => s?.url).map(s => ({ loc: site + s.url })),
    { loc: `${site}/privacy` },
  ];
}
