// Netlify Function: marketplace-waitlist. The "Get notified" form on the landing page (index.html) posts
// { email, company } here. Adds the email to Loops as a contact (source and userGroup "marketplace-waitlist").
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
  try {
    const r = await fetchImpl('https://app.loops.so/api/v1/contacts/create', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, source: 'marketplace-waitlist', userGroup: 'marketplace-waitlist' }),
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok || r.status === 409) return json(200, { ok: true });   // 409 = already a contact
    const text = await r.text().catch(() => '');
    if (/already/i.test(text)) return json(200, { ok: true });
    console.error('[marketplace-waitlist] Loops', r.status, text.slice(0, 200));
    return json(502, { ok: false, error: 'signup_failed' });
  } catch (e) {
    console.error('[marketplace-waitlist]', e.message);
    return json(502, { ok: false, error: 'signup_failed' });
  }
}

exports.handler = event => handle(event);
exports._test = { handle };
