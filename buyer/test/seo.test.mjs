// robots.txt and sitemap.xml (src/lib/seo.js).   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRobots, buildSitemap, collectSitemap } from '../src/lib/seo.js';

const SITE = 'https://getcardshow.com';

test('before launch: marketplace closed to crawlers, no sitemap, main site still open', () => {
  const r = buildRobots({ indexing: false, site: SITE });
  for (const p of ['/search', '/c/', '/d/', '/account', '/app', '/.netlify/', '/mcp']) assert.match(r, new RegExp(`^Disallow: ${p.replace(/[./]/g, '\\$&')}$`, 'm'));
  assert.match(r, /^User-agent: \*$/m);
  assert.match(r, /^Allow: \/$/m);
  assert.doesNotMatch(r, /Sitemap:/);
});

test('after launch: marketplace open, private pages closed, sitemap advertised', () => {
  const r = buildRobots({ indexing: true, site: SITE });
  for (const p of ['/search', '/c/', '/d/']) assert.doesNotMatch(r, new RegExp(`^Disallow: ${p.replace(/[./]/g, '\\$&')}$`, 'm'));
  for (const p of ['/account', '/app', '/.netlify/', '/mcp']) assert.match(r, new RegExp(`^Disallow: ${p.replace(/[./]/g, '\\$&')}$`, 'm'));
  assert.match(r, /^Sitemap: https:\/\/getcardshow\.com\/sitemap\.xml$/m);
});

test('sitemap XML: escaped, no duplicates, lastmod only when known', () => {
  const xml = buildSitemap([{ loc: `${SITE}/c/1-a&b`, lastmod: '2026-11-20' }, { loc: `${SITE}/c/1-a&b` }, { loc: `${SITE}/` }]);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.equal((xml.match(/<url>/g) || []).length, 2);
  assert.match(xml, /<loc>https:\/\/getcardshow\.com\/c\/1-a&amp;b<\/loc><lastmod>2026-11-20<\/lastmod>/);
  assert.match(xml, /<url><loc>https:\/\/getcardshow\.com\/<\/loc><\/url>/);
});

test('collect: every page of listings, dealers once each, upcoming shows', async () => {
  const all = Array.from({ length: 120 }, (_, i) => ({
    url: `/c/id${i}-card-${i}`, listed_at: `2026-11-${String(1 + (i % 20)).padStart(2, '0')}T10:00:00Z`,
    dealer: { handle: i % 2 ? 'dealer_b' : 'dealer_a', url: i % 2 ? '/d/dealer_b' : '/d/dealer_a' } }));
  const calls = [];
  const rpc = async (name, args) => {
    calls.push([name, args?.p?.offset]);
    if (name === 'search_listings') {
      assert.equal(args.p.sort, 'newest'); assert.equal(args.p.limit, 50);
      return { total: all.length, results: all.slice(args.p.offset, args.p.offset + 50) };
    }
    if (name === 'list_upcoming_shows') return [{ url: '/s/show-1-2026' }];
    throw new Error('unexpected ' + name);
  };
  const entries = await collectSitemap({ rpc, site: SITE });
  const locs = entries.map(e => e.loc);
  assert.equal(locs.filter(l => l.includes('/c/')).length, 120);
  assert.deepEqual(calls.filter(([n]) => n === 'search_listings').map(([, o]) => o).sort((a, b) => a - b), [0, 50, 100]);
  assert.equal(locs.filter(l => l.endsWith('/d/dealer_a')).length, 1);
  assert.ok(locs.includes(`${SITE}/d/dealer_b`) && locs.includes(`${SITE}/s/show-1-2026`) && locs.includes(`${SITE}/`)
    && locs.includes(`${SITE}/privacy`));
  assert.equal(entries.find(e => e.loc === `${SITE}/search`).lastmod, '2026-11-20');
});

test('collect: a show lookup failure still returns the listings', async () => {
  const rpc = async name => {
    if (name === 'search_listings') return { total: 1, results: [{ url: '/c/x-y', listed_at: null, dealer: { handle: 'h', url: '/d/h' } }] };
    throw new Error('down');
  };
  const locs = (await collectSitemap({ rpc, site: SITE })).map(e => e.loc);
  assert.ok(locs.includes(`${SITE}/c/x-y`) && locs.includes(`${SITE}/d/h`));
});
