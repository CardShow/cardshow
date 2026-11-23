// Netlify Function: marketplace-waitlist. The "Get notified" form on the landing page (index.html) posts
// { email, company } here. Marks the email in Loops with the custom field marketplaceWaitlist = true (boolean,
// created in Loops 2026-11-23). userGroup is left alone: it holds Seller / Organizer roles.
//   New contact: contacts/create with source "marketplace-waitlist" and the field.
//   Existing contact (409): contacts/update with only the field, so its source and userGroup are kept.
// "company" is a honeypot: a bot that fills it gets { ok: true } and nothing is saved.
// Needs LOOPS_API_KEY (already used by the hold and saved-search emails). Never expose it to the page.

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function handle(event, deps = {}) {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'post_only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'bad_json' }); }
  if (body && typeof body.company === 'string' && body.company.trim()) return json(200, { ok: true });

  const email = String(body?.email || '').trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return json(400, { ok: false, error: 'invalid_email' });

  const key = process.env.LOOPS_API_KEY;
  if (!key) { console.error('[marketplace-waitlist] LOOPS_API_KEY not set'); return json(503, { ok: false, error: 'not_configured' }); }

  const fetchImpl = deps.fetchImpl || fetch;
  const call = (method, path, payload) => fetchImpl(`https://app.loops.so/api/v1/contacts/${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(6000),
  });
  try {
    let r = await call('POST', 'create', { email, source: 'marketplace-waitlist', marketplaceWaitlist: true });
    if (r.ok) return json(200, { ok: true });
    const text = await r.text().catch(() => '');
    if (r.status === 409 || /already/i.test(text)) {
      r = await call('PUT', 'update', { email, marketplaceWaitlist: true });
      if (r.ok) return json(200, { ok: true });
      console.error('[marketplace-waitlist] Loops update', r.status, (await r.text().catch(() => '')).slice(0, 200));
      return json(502, { ok: false, error: 'signup_failed' });
    }
    console.error('[marketplace-waitlist] Loops', r.status, text.slice(0, 200));
    return json(502, { ok: false, error: 'signup_failed' });
  } catch (e) {
    console.error('[marketplace-waitlist]', e.message);
    return json(502, { ok: false, error: 'signup_failed' });
  }
}

exports.handler = event => handle(event);
exports._test = { handle };
