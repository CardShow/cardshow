// Netlify Function: photo-link. Behind getcardshow.com/photo/<code> (photo-link.html), the short-lived link an
// assistant gives a dealer (seller MCP server, Phase 3b). The 10-character code is the only key: it lasts 30 minutes
// and only reaches what it was made for.
//   kind 'attach': the cards just added with add_cards. Each upload becomes that card's photo.
//   kind 'scan':   a photo batch. Uploads join the batch; "Send to Claude" starts the scan-card reader
//                  (mcp-photo-job-background) and the assistant confirms the drafts with add_cards_from_photos.
// POST JSON {action: 'info' | 'upload' | 'done', code, card_id?, image_base64?}. Uses the service key; every write
// is scoped to the link's owner (photos go in that dealer's own folder of the private card-captures bucket).

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const MAX_BYTES = 3.5 * 1024 * 1024;
const MAX_UPLOADS = 40;
const MAX_SCAN_PHOTOS = 20;
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
function clientIp(event) {
  const h = event.headers || {};
  return String(h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || '').split(',')[0].trim();
}

async function findLink(db, code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 10) return null;
  const { data } = await db.from('mcp_photo_links').select('*').eq('code_hash', sha(c)).maybeSingle();
  return data || null;
}

async function cardsFor(db, link) {
  if (link.kind !== 'attach' || !link.inventory_ids?.length) return [];
  const { data } = await db.from('inventory').select('id, card_title, stock_code, primary_capture_id, seller_id')
    .in('id', link.inventory_ids).eq('seller_id', link.owner_id);
  const order = new Map(link.inventory_ids.map((id, i) => [id, i]));
  return (data || []).sort((a, b) => order.get(a.id) - order.get(b.id))
    .map(c => ({ id: c.id, title: c.card_title || 'Card', stock_code: c.stock_code || null, has_photo: !!c.primary_capture_id }));
}

async function kickReader(jobId, deps) {
  if (deps.kickReader) return deps.kickReader(jobId);
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  const base = (process.env.DEPLOY_PRIME_URL || process.env.URL || 'https://getcardshow.com').replace(/\/$/, '');
  try {
    await fetch(`${base}/.netlify/functions/mcp-photo-job-background`, {
      method: 'POST', signal: AbortSignal.timeout(4000),
      headers: { 'Content-Type': 'application/json', 'x-cardshow-photo-job': sha('mcp-photo-job:' + key) },
      body: JSON.stringify({ job_id: jobId }),
    });
  } catch (e) { console.warn('[photo-link] reader kick failed:', e.message); }
}

async function handle(event, deps = {}) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'post_only' });
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  const db = deps.db || (url && key ? createClient(url, key, { auth: { persistSession: false } }) : null);
  if (!db) return json(503, { error: 'not_configured' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }

  // Guessing codes: 30 lookups a minute per address.
  const ip = clientIp(event);
  if (ip) {
    const { data: rl } = await db.rpc('rate_limit_hit', { p_key: `photolink:${sha(ip).slice(0, 24)}`, p_window_seconds: 60, p_max: 30 });
    if (rl && rl.allowed === false) return json(429, { error: 'slow_down' });
  }
  const link = await findLink(db, body.code);
  if (!link) return json(404, { error: 'not_found' });
  const expired = new Date(link.expires_at) < new Date();
  const action = body.action || 'info';

  if (action === 'info') {
    let photos = 0, jobStatus = null;
    if (link.kind === 'scan') {
      const { data: job } = await db.from('mcp_photo_jobs').select('status, images').eq('id', link.job_id).maybeSingle();
      photos = Array.isArray(job?.images) ? job.images.length : 0;
      jobStatus = job?.status || null;
    }
    return json(200, { kind: link.kind, expired, expires_at: link.expires_at, finished: !!link.finished_at || (jobStatus && jobStatus !== 'collecting'),
      cards: await cardsFor(db, link), photos, max_photos: MAX_SCAN_PHOTOS });
  }
  if (expired) return json(410, { error: 'expired' });
  if (link.uploads >= MAX_UPLOADS && action === 'upload') return json(429, { error: 'too_many_uploads' });

  if (action === 'upload') {
    let buf;
    try { buf = Buffer.from(String(body.image_base64 || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch { buf = Buffer.alloc(0); }
    const type = imageType(buf);
    if (!type) return json(400, { error: 'not_an_image' });
    if (buf.length > MAX_BYTES) return json(413, { error: 'too_big' });
    const captureId = crypto.randomUUID();
    const objKey = `${link.owner_id}/${captureId}/original.jpg`;

    if (link.kind === 'attach') {
      const cardId = String(body.card_id || '');
      if (!link.inventory_ids.includes(cardId)) return json(404, { error: 'card_not_in_link' });
      const { data: card } = await db.from('inventory').select('id, seller_id, status').eq('id', cardId).eq('seller_id', link.owner_id).maybeSingle();
      if (!card) return json(404, { error: 'card_not_found' });
      const up = await db.storage.from('card-captures').upload(objKey, buf, { contentType: type, upsert: false });
      if (up.error) return json(500, { error: 'upload_failed' });
      const { error: cErr } = await db.from('card_captures').insert({ id: captureId, seller_id: link.owner_id, entry_point: 'case_scan',
        original_key: objKey, inventory_id: cardId, status: 'attached', uploaded_at: new Date().toISOString() });
      if (cErr) return json(500, { error: 'save_failed' });
      const { error: iErr } = await db.from('inventory').update({ primary_capture_id: captureId, image_source: 'seller' })
        .eq('id', cardId).eq('seller_id', link.owner_id);
      if (iErr) return json(500, { error: 'save_failed' });
      await db.from('mcp_photo_links').update({ uploads: link.uploads + 1 }).eq('id', link.id);
      return json(200, { ok: true, card_id: cardId });
    }

    // scan
    const { data: job } = await db.from('mcp_photo_jobs').select('id, status, images').eq('id', link.job_id).eq('owner_id', link.owner_id).maybeSingle();
    if (!job) return json(404, { error: 'not_found' });
    if (job.status !== 'collecting') return json(409, { error: 'already_sent' });
    const images = Array.isArray(job.images) ? job.images : [];
    if (images.length >= MAX_SCAN_PHOTOS) return json(429, { error: 'batch_full' });
    const up = await db.storage.from('card-captures').upload(objKey, buf, { contentType: type, upsert: false });
    if (up.error) return json(500, { error: 'upload_failed' });
    const next = [...images, { n: images.length + 1, source: 'upload', media_type: type, capture_id: captureId, key: objKey, status: 'waiting' }];
    const { error: jErr } = await db.from('mcp_photo_jobs').update({ images: next, updated_at: new Date().toISOString() })
      .eq('id', job.id).eq('status', 'collecting');
    if (jErr) return json(500, { error: 'save_failed' });
    await db.from('mcp_photo_links').update({ uploads: link.uploads + 1 }).eq('id', link.id);
    return json(200, { ok: true, photos: next.length });
  }

  if (action === 'done') {
    if (link.kind !== 'scan') {
      await db.from('mcp_photo_links').update({ finished_at: new Date().toISOString() }).eq('id', link.id);
      return json(200, { ok: true });
    }
    const { data: job } = await db.from('mcp_photo_jobs').select('id, status, images').eq('id', link.job_id).eq('owner_id', link.owner_id).maybeSingle();
    if (!job) return json(404, { error: 'not_found' });
    if (job.status === 'collecting') {
      if (!(job.images || []).length) return json(400, { error: 'no_photos' });
      await db.from('mcp_photo_jobs').update({ status: 'working', updated_at: new Date().toISOString() }).eq('id', job.id).eq('status', 'collecting');
      await db.from('mcp_photo_links').update({ finished_at: new Date().toISOString() }).eq('id', link.id);
      await kickReader(job.id, deps);
    }
    return json(200, { ok: true });
  }
  return json(400, { error: 'bad_action' });
}

exports.handler = (event) => handle(event);
exports._test = { handle, imageType, sha };
