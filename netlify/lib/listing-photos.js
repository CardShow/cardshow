// Public listing photos (Marketplace Phase 1, buyer site).
// Seller photos are in the private card-captures bucket. A listed card's photo is copied to the public
// listing-photos bucket (<card id>/<capture id>.jpg) so the buyer site, link previews and Google can show it
// without signed links that expire. The public copy is deleted when the card is delisted, sold or flagged,
// or the seller replaces the photo. Which cards need what comes from listing_photos_due()
// (20261203120000_marketplace_buyer_site.sql); listing_photo_set() records each change.

const SRC_BUCKET = 'card-captures';
const DST_BUCKET = 'listing-photos';

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

// db: a Supabase client with the service key. ids: limit to these cards (optional).
async function syncListingPhotos(db, { ids = null, limit = 50, budgetMs = 20000, now = Date.now } = {}) {
  const started = now();
  const out = { added: 0, removed: 0, failed: 0, errors: [] };
  const { data: due, error } = await db.rpc('listing_photos_due', { p_ids: ids && ids.length ? ids : null, p_limit: limit });
  if (error) throw new Error(error.message);
  const fail = (id, msg) => { out.failed += 1; if (out.errors.length < 10) out.errors.push({ id, error: msg }); };
  const removeObject = async path => {
    if (!path) return;
    const { error: e } = await db.storage.from(DST_BUCKET).remove([path]);
    if (e) console.warn('[listing-photos] remove failed', path, e.message);
  };

  await pool(due?.remove || [], 4, async r => {
    if (now() - started > budgetMs) return;
    try {
      await removeObject(r.old_path);
      const { error: e } = await db.rpc('listing_photo_set', { p_id: r.id, p_capture_id: null, p_path: null });
      if (e) throw new Error(e.message);
      out.removed += 1;
    } catch (e) { fail(r.id, e.message); }
  });

  await pool(due?.add || [], 4, async a => {
    if (now() - started > budgetMs) return;
    try {
      const { data: blob, error: dErr } = await db.storage.from(SRC_BUCKET).download(a.key);
      if (dErr || !blob) throw new Error(`download: ${dErr?.message || 'empty'}`);
      const bytes = Buffer.from(await blob.arrayBuffer());
      const path = `${a.id}/${a.capture_id}.jpg`;
      const { error: uErr } = await db.storage.from(DST_BUCKET).upload(path, bytes,
        { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' });
      if (uErr) throw new Error(`upload: ${uErr.message}`);
      const { data: set, error: sErr } = await db.rpc('listing_photo_set', { p_id: a.id, p_capture_id: a.capture_id, p_path: path });
      if (sErr) throw new Error(sErr.message);
      const old = set?.old_path || (a.old_path !== path ? a.old_path : null);
      if (old && old !== path) await removeObject(old);
      out.added += 1;
    } catch (e) { fail(a.id, e.message); }
  });

  out.remaining = Math.max(0, (due?.add?.length || 0) + (due?.remove?.length || 0) - out.added - out.removed - out.failed);
  return out;
}

// Public URL of a listed card's photo (image.photo_path from the listing functions).
function publicPhotoUrl(supabaseUrl, path) {
  if (!path || !supabaseUrl) return null;
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${DST_BUCKET}/${path}`;
}

module.exports = { syncListingPhotos, publicPhotoUrl, SRC_BUCKET, DST_BUCKET };
