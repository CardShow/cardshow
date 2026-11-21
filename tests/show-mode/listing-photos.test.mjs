// Public listing photos: netlify/lib/listing-photos.js + listing-photos-now.js, against a fake Supabase.
//   node tests/show-mode/listing-photos.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { syncListingPhotos, publicPhotoUrl } = require('../../netlify/lib/listing-photos.js');
const now = require('../../netlify/functions/listing-photos-now.js');

let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); };

function fakeDb({ due, missing = [], owner = {} } = {}) {
  const log = { rpc: [], uploads: [], removes: [], downloads: [] };
  const db = {
    log,
    rpc: async (name, args) => {
      log.rpc.push({ name, args });
      if (name === 'listing_photos_due') {
        const f = x => !args.p_ids || args.p_ids.includes(x.id);
        return { data: { add: due.add.filter(f), remove: due.remove.filter(f) }, error: null };
      }
      if (name === 'listing_photo_set') return { data: { ok: true, old_path: args.p_path ? (due.add.find(a => a.id === args.p_id)?.old_path || null) : null }, error: null };
      return { data: null, error: { message: 'unknown rpc' } };
    },
    storage: {
      from: bucket => ({
        download: async key => { log.downloads.push([bucket, key]);
          return missing.includes(key) ? { data: null, error: { message: 'Object not found' } }
                                       : { data: new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), error: null }; },
        upload: async (path, bytes, opts) => { log.uploads.push([bucket, path, opts.contentType, bytes.length]); return { error: null }; },
        remove: async paths => { log.removes.push([bucket, ...paths]); return { error: null }; },
      }),
    },
    auth: { getUser: async t => t === 'good' ? { data: { user: { id: 'seller-a' } }, error: null } : { data: null, error: { message: 'bad' } } },
    from: () => {
      const q = { ids: [], seller: null,
        select() { return q; }, in(_c, ids) { q.ids = ids; return q; },
        eq(_c, v) { q.seller = v; return Promise.resolve({ data: q.ids.filter(id => owner[id] === v).map(id => ({ id })), error: null }); } };
      return q;
    },
  };
  return db;
}

const A = 'a0000000-0000-4000-8000-000000000001', B = 'a0000000-0000-4000-8000-000000000002', C = 'a0000000-0000-4000-8000-000000000003';
const due = {
  add: [{ id: A, capture_id: 'cap-a', key: 'seller-a/cap-a/crop.jpg', old_path: null },
        { id: B, capture_id: 'cap-b2', key: 'seller-a/cap-b2/crop.jpg', old_path: `${B}/cap-b1.jpg` },
        { id: C, capture_id: 'cap-c', key: 'gone.jpg', old_path: null }],
  remove: [{ id: 'd0000000-0000-4000-8000-000000000004', old_path: 'd0000000-0000-4000-8000-000000000004/cap-d.jpg' }],
};

{
  const db = fakeDb({ due, missing: ['gone.jpg'] });
  const out = await syncListingPhotos(db);
  check('copies each listed photo from the private bucket to listing-photos/<card>/<capture>.jpg',
    db.log.downloads.some(([b, k]) => b === 'card-captures' && k === 'seller-a/cap-a/crop.jpg')
    && db.log.uploads.some(([b, p, t]) => b === 'listing-photos' && p === `${A}/cap-a.jpg` && t === 'image/jpeg'), JSON.stringify(db.log.uploads));
  check('records it with listing_photo_set', db.log.rpc.some(r => r.name === 'listing_photo_set' && r.args.p_id === A && r.args.p_path === `${A}/cap-a.jpg`));
  check('a replaced photo deletes the old public copy', db.log.removes.some(r => r[0] === 'listing-photos' && r[1] === `${B}/cap-b1.jpg`));
  check('delisted/sold: public copy deleted and cleared', db.log.removes.some(r => r[1] === 'd0000000-0000-4000-8000-000000000004/cap-d.jpg')
    && db.log.rpc.some(r => r.name === 'listing_photo_set' && r.args.p_id.startsWith('d0') && r.args.p_path === null));
  check('a missing source photo fails that card only', out.added === 2 && out.removed === 1 && out.failed === 1 && out.errors[0].id === C, JSON.stringify(out));
}

check('public URL', publicPhotoUrl('https://x.supabase.co/', 'a/b.jpg') === 'https://x.supabase.co/storage/v1/object/public/listing-photos/a/b.jpg'
  && publicPhotoUrl('https://x.supabase.co', null) === null);

// listing-photos-now: signed-in seller, own cards only
{
  const db = fakeDb({ due, owner: { [A]: 'seller-a', [B]: 'seller-b' } });
  const ev = (token, ids) => ({ httpMethod: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ ids }) });
  let r = await now._test.handle(ev(null, [A]), { db });
  check('now: sign-in required', r.statusCode === 401);
  r = await now._test.handle(ev('bad', [A]), { db });
  check('now: bad token refused', r.statusCode === 401);
  r = await now._test.handle(ev('good', ['not-a-uuid']), { db });
  check('now: needs card ids', r.statusCode === 400);
  r = await now._test.handle(ev('good', [A, B]), { db });
  const body = JSON.parse(r.body);
  const dueCall = db.log.rpc.find(x => x.name === 'listing_photos_due');
  check('now: only the caller\'s own cards are synced', r.statusCode === 200 && JSON.stringify(dueCall.args.p_ids) === JSON.stringify([A]) && body.added === 1, r.body);
  r = await now._test.handle({ httpMethod: 'GET', headers: {} }, { db });
  check('now: POST only', r.statusCode === 405);
}

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
