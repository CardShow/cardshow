// node tests/show-mode/marketplace-waitlist.test.mjs: the landing page waitlist function, Loops stubbed.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { handle } = require('../../netlify/functions/marketplace-waitlist.js')._test;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };
const ev = (body, method = 'POST') => ({ httpMethod: method, body: typeof body === 'string' ? body : JSON.stringify(body) });
// stub(status, text) or stub([[status, text], ...]) for successive calls
const stub = (status, text = '{}') => { const calls = []; const seq = Array.isArray(status) ? status : [[status, text]];
  const f = async (url, opts) => { const [st, tx = '{}'] = seq[Math.min(calls.length, seq.length - 1)]; calls.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok: st < 300, status: st, text: async () => tx }; }; f.calls = calls; return f; };

process.env.LOOPS_API_KEY = 'test-key';
let f = stub(200);
let r = await handle(ev({ email: ' Test@Example.com ' }), { fetchImpl: f });
ok(r.statusCode === 200 && JSON.parse(r.body).ok === true, 'valid email → ok');
const sent = JSON.parse(f.calls[0].opts.body);
ok(f.calls[0].url === 'https://app.loops.so/api/v1/contacts/create', 'posts to contacts/create');
ok(sent.email === 'test@example.com' && sent.source === 'marketplace-waitlist' && sent.marketplaceWaitlist === true, 'payload');
ok(!('userGroup' in sent), 'userGroup not sent');
ok(f.calls.length === 1, 'new contact: one call');
ok(f.calls[0].opts.headers.Authorization === 'Bearer test-key', 'bearer key');

f = stub([[409, '{"success":false,"message":"Email or userId is already on your audience."}'], [200]]);
r = await handle(ev({ email: 'seller@b.co' }), { fetchImpl: f });
ok(JSON.parse(r.body).ok === true, 'existing contact (409) → ok');
ok(f.calls.length === 2 && f.calls[1].url.endsWith('/contacts/update') && f.calls[1].opts.method === 'PUT', 'existing contact → update');
ok(JSON.stringify(Object.keys(f.calls[1].body).sort()) === '["email","marketplaceWaitlist"]' && f.calls[1].body.marketplaceWaitlist === true,
   'update sends only email + field (source and userGroup kept)');
f = stub([[400, '{"message":"Email address already exists"}'], [200]]);
r = await handle(ev({ email: 'a@b.co' }), { fetchImpl: f });
ok(JSON.parse(r.body).ok === true && f.calls.length === 2, 'already-exists message → update → ok');
r = await handle(ev({ email: 'a@b.co' }), { fetchImpl: stub([[409, 'already'], [500, 'boom']]) });
ok(r.statusCode === 502 && JSON.parse(r.body).ok === false, 'update fails → ok false');
r = await handle(ev({ email: 'a@b.co' }), { fetchImpl: stub(500, 'boom') });
ok(r.statusCode === 502 && JSON.parse(r.body).ok === false, 'Loops error → ok false');
r = await handle(ev({ email: 'a@b.co' }), { fetchImpl: async () => { throw new Error('net'); } });
ok(r.statusCode === 502, 'network error → 502');

f = stub(200);
r = await handle(ev({ email: 'nope' }), { fetchImpl: f });
ok(r.statusCode === 400 && JSON.parse(r.body).error === 'invalid_email' && !f.calls.length, 'invalid email refused, no call');
r = await handle(ev({ email: 'bot@spam.com', company: 'Acme' }), { fetchImpl: f });
ok(JSON.parse(r.body).ok === true && !f.calls.length, 'honeypot → ok, nothing saved');
r = await handle(ev({}, 'GET'), { fetchImpl: f });
ok(r.statusCode === 405, 'GET refused');
r = await handle(ev('{bad'), { fetchImpl: f });
ok(r.statusCode === 400, 'bad json');
delete process.env.LOOPS_API_KEY;
r = await handle(ev({ email: 'a@b.co' }), { fetchImpl: f });
ok(r.statusCode === 503 && !f.calls.length, 'no key → 503');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
