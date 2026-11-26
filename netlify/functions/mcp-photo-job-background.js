// Netlify Background Function: mcp-photo-job-background. Reads the photos of one add_cards_from_photos batch
// (seller MCP server, Phase 3) with the same scan-card identification the app uses, and stores a draft per photo
// on mcp_photo_jobs. Nothing is added to inventory here: the dealer confirms the drafts through the MCP tool.
//
// POST { job_id } with header x-cardshow-photo-job = sha256('mcp-photo-job:' + SUPABASE_SERVICE_KEY) (sent by
// mcp-seller.js). Uses the service key: the job belongs to the dealer who started it (owner_id), and every photo
// is stored in that dealer's own folder of the private card-captures bucket, as a card_captures row of theirs.
// Photos given as URLs are fetched here: https only, public hosts only, 3.5 MB max, JPEG/PNG/WebP.

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { createClient } = require('@supabase/supabase-js');

const MAX_BYTES = 3.5 * 1024 * 1024;
const CONCURRENCY = 3;

function token(key) { return crypto.createHash('sha256').update('mcp-photo-job:' + key).digest('hex'); }
function header(event, name) {
  const h = event.headers || {};
  return h[name] || Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1] || '';
}
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

// Private, loopback, link-local and other non-public addresses.
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9')
    || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}
async function checkUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error('Not a valid URL'); }
  if (url.protocol !== 'https:') throw new Error('Only https links are accepted');
  if (url.username || url.password) throw new Error('Links with a username or password are not accepted');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('That address is not public');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('That address is not public');
  return url;
}
// Fetches a photo: redirects followed by hand (each hop checked), size capped while reading.
async function fetchPhoto(u, fetchImpl = fetch, lookup = checkUrl) {
  let url = await lookup(u);
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetchImpl(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'image/jpeg,image/png,image/webp' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      url = await lookup(new URL(r.headers.get('location'), url).toString());
      continue;
    }
    if (!r.ok) throw new Error(`The photo link answered ${r.status}`);
    if (Number(r.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('The photo is over 3.5 MB');
    const chunks = []; let size = 0;
    for await (const c of r.body) {
      size += c.length;
      if (size > MAX_BYTES) throw new Error('The photo is over 3.5 MB');
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many redirects');
}

async function identify(buf, type, scan) {
  const res = await scan({ httpMethod: 'POST', body: JSON.stringify({ image_base64: buf.toString('base64'), media_type: type }) });
  let body = {};
  try { body = JSON.parse(res.body || '{}'); } catch { /* handled below */ }
  if (!body.success || !body.card) throw new Error(body.error === 'timeout' ? 'Reading the photo timed out' : 'Couldn\'t read this photo');
  return body.card;
}

async function processImage(db, job, im, deps) {
  let buf;
  if (im.source === 'upload') {
    const { data, error } = await db.storage.from('card-captures').download(im.key);
    if (error || !data) throw new Error('The photo didn\'t arrive');
    buf = Buffer.from(await data.arrayBuffer());
  } else {
    buf = await fetchPhoto(im.url, deps.fetchImpl, deps.checkUrl);
  }
  const type = imageType(buf);
  if (!type) throw new Error('Not a JPEG, PNG or WebP image');
  if (buf.length > MAX_BYTES) throw new Error('The photo is over 3.5 MB');
  if (im.source === 'url') {
    const { error } = await db.storage.from('card-captures').upload(im.key, buf, { contentType: type, upsert: true });
    if (error) throw new Error('Couldn\'t save the photo');
  }
  const card = await identify(buf, type, deps.scan);
  const conf = card.confidence || {};
  const vals = Object.values(conf).map(Number).filter(n => !Number.isNaN(n));
  const min = vals.length ? Math.min(...vals) : 0;
  const { error: cErr } = await db.from('card_captures').upsert({
    id: im.capture_id, seller_id: job.owner_id, entry_point: 'case_scan', original_key: im.key,
    cert_number: card.cert_number || null, grader: card.grading_company || null, grade: card.grade || null,
    confidence: min >= 0.85 ? 'high' : min >= 0.7 ? 'medium' : 'low', identification: { source: 'scan-card', card },
    status: 'unattached', uploaded_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (cErr) throw new Error('Couldn\'t save the photo record');
  return card;
}

async function runJob(db, jobId, deps = {}) {
  const now = new Date();
  // Claim the job (one worker at a time; a claim older than 5 minutes can be retaken).
  const { data: claimed } = await db.from('mcp_photo_jobs')
    .update({ claimed_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', jobId).eq('status', 'working')
    .or(`claimed_at.is.null,claimed_at.lt.${new Date(now - 5 * 60000).toISOString()}`)
    .select('*').maybeSingle();
  if (!claimed) return { skipped: true };
  const job = claimed;
  const images = Array.isArray(job.images) ? job.images.map(x => ({ ...x })) : [];
  const save = async () => {
    await db.from('mcp_photo_jobs').update({ images, updated_at: new Date().toISOString() }).eq('id', job.id);
  };
  const todo = images.filter(im => im.status === 'waiting');
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(async (im) => {
      try {
        im.card = await processImage(db, job, im, deps);
        im.status = 'done';
      } catch (e) {
        im.status = 'failed';
        im.error = String(e.message || 'Couldn\'t read this photo').slice(0, 120);
      }
    }));
    await save();
  }
  await db.from('mcp_photo_jobs').update({ images, status: 'done', finished_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), claimed_at: null }).eq('id', job.id);
  return { done: images.filter(x => x.status === 'done').length, failed: images.filter(x => x.status === 'failed').length };
}

async function handle(event, deps = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  if (event.httpMethod !== 'POST' || !key) return { statusCode: 404, body: '' };
  const got = String(header(event, 'x-cardshow-photo-job'));
  const want = token(key);
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return { statusCode: 403, body: '' };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: '' }; }
  const jobId = String(body.job_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return { statusCode: 400, body: '' };
  const db = deps.db || createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false } });
  const scan = deps.scan || require('./scan-card').handler;
  try {
    const out = await runJob(db, jobId, { ...deps, scan });
    console.log('[mcp-photo-job]', jobId, JSON.stringify(out));
  } catch (e) {
    console.error('[mcp-photo-job]', jobId, e.message);
  }
  return { statusCode: 202, body: '' };
}

exports.handler = (event) => handle(event);
exports._test = { handle, runJob, fetchPhoto, checkUrl, privateIp, imageType, token };
