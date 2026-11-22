// Tile image URLs (src/lib/format.js).   npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { imageFor, thumbUrl } from '../src/lib/format.js';

const SB = 'https://x.supabase.co', SITE = 'https://getcardshow.com';
const photo = { image: { photo_path: 'a/b.jpg' } };

test('grid tiles use a resized dealer photo on Netlify', () => {
  const full = `${SB}/storage/v1/object/public/listing-photos/a/b.jpg`;
  const img = imageFor(photo, { supabaseUrl: SB, siteUrl: SITE, thumb: 480, cdn: true });
  assert.equal(img.url, `/.netlify/images?url=${encodeURIComponent(full)}&w=480&q=72`);
  assert.equal(img.full, full);
  assert.equal(thumbUrl(full, 480), img.url);
});

test('off Netlify, or without a width, the photo is used as is', () => {
  const full = `${SB}/storage/v1/object/public/listing-photos/a/b.jpg`;
  assert.equal(imageFor(photo, { supabaseUrl: SB, siteUrl: SITE, thumb: 480, cdn: false }).url, full);
  assert.equal(imageFor(photo, { supabaseUrl: SB, siteUrl: SITE, cdn: true }).url, full);
});

test('catalog images are never resized (already small)', () => {
  const img = imageFor({ image: { stock_image_url: '/.netlify/functions/card-image?id=1' } }, { supabaseUrl: SB, siteUrl: SITE, thumb: 480, cdn: true });
  assert.equal(img.url, `${SITE}/.netlify/functions/card-image?id=1`); assert.equal(img.kind, 'catalog');
});
