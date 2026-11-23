// Hold emails: netlify/lib/hold-notices.js and netlify/functions/hold-notify-now.js, with Supabase and Loops stubbed.
//   node hold-notices.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { runHoldNotices, compose } = require('../../netlify/lib/hold-notices.js');
const { handle } = require('../../netlify/functions/hold-notify-now.js')._test;

let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); };
const card = { id: 'a1', title: '1999 Pokemon Base Set Charizard Holo PSA 10', price_cents: 18000, stock_code: 'S-12', url: '/c/a1-charizard' };
const R1 = '11111111-1111-4111-8111-111111111111', R2 = '22222222-2222-4222-8222-222222222222';
const notices = () => [
  { reservation_id: R1, kind: 'placed', to: 'dealer', email: 'dealer@example.test', buyer_name: 'Alex', buyer_contact: '555-0100',
    buyer_note: 'Saturday', expires_at: '2026-11-24T23:00:00Z', dealer: { handle: 'dealer_a', display_name: 'Dealer A' }, cards: [card] },
  { reservation_id: R2, kind: 'ended', to: 'buyer', email: 'buyer@example.test', end_reason: 'sold_elsewhere', status: 'broken',
    dealer: { handle: 'dealer_a', display_name: 'Dealer A' }, cards: [card] },
  { reservation_id: R2, kind: 'ended', to: 'none', end_reason: 'sold_to_holder', cards: [card] },
];
function fakeDb(rows, users = {}) {
  const st = { sent: [], dueArgs: [] };
  return { st,
    rpc: async (name, args) => {
      if (name === 'hold_notices_due') { st.dueArgs.push(args); return { data: args.p_reservation_id ? rows.filter(r => r.reservation_id === args.p_reservation_id) : rows }; }
      if (name === 'hold_notice_sent') { st.sent.push([args.p_reservation_id, args.p_kind]); return { data: null }; }
      if (name === 'hold_party') return { data: users[args.p_user]?.includes(args.p_reservation_id) || false };
      return { data: null };
    },
    auth: { getUser: async t => (t === 'tok-dealer' ? { data: { user: { id: 'dealer' } } } : t === 'tok-x' ? { data: { user: { id: 'x' } } } : { error: { message: 'bad' } }) },
  };
}
const loops = calls => async (url, opts) => { calls.push(JSON.parse(opts.body)); return new Response('{}', { status: 200 }); };

// copy
const p = compose(notices()[0]);
check('dealer email: who, card, contact, when, app link', p.templateEnv === 'LOOPS_HOLD_DEALER_ID' && /Alex is holding 1999 Pokemon/.test(p.vars.headline)
  && /555-0100/.test(p.vars.message) && /Pacific/.test(p.vars.holdEnds) && p.vars.cardList === 'S-12 · 1999 Pokemon Base Set Charizard Holo PSA 10 · $180'
  && p.vars.actionUrl === 'https://getcardshow.com/app', JSON.stringify(p));
const b = compose(notices()[1]);
check('buyer email when sold at the table: honest either way', b.templateEnv === 'LOOPS_HOLD_BUYER_ID' && /If you bought it, you're all set/.test(b.vars.message)
  && b.vars.actionUrl.endsWith('/search'));
check('buyer email when released / expired links back to the card',
  compose({ ...notices()[1], end_reason: 'dealer_released' }).vars.actionUrl === 'https://getcardshow.com/c/a1-charizard'
  && /released your hold/.test(compose({ ...notices()[1], end_reason: 'dealer_released' }).vars.message)
  && /Your hold on .* ended/.test(compose({ ...notices()[1], end_reason: 'hold expired' }).vars.message));
check('nobody emailed when sold to the holder', compose(notices()[2]) === null);

// not set up: nothing marked except the no-email row
delete process.env.LOOPS_API_KEY;
let db = fakeDb(notices()), calls = [];
let out = await runHoldNotices(db, { fetchImpl: loops(calls), log: {} });
check('Loops not set up: emails wait, no-email rows still marked', out.waiting === 2 && out.skipped === 1 && calls.length === 0
  && db.st.sent.length === 1 && db.st.sent[0][1] === 'ended', JSON.stringify(out));

process.env.LOOPS_API_KEY = 'k'; process.env.LOOPS_HOLD_DEALER_ID = 'tid-dealer'; process.env.LOOPS_HOLD_BUYER_ID = 'tid-buyer';
db = fakeDb(notices()); calls = [];
out = await runHoldNotices(db, { fetchImpl: loops(calls) });
check('set up: two emails to the right people, all three marked', out.emailed === 2 && out.skipped === 1
  && calls[0].transactionalId === 'tid-dealer' && calls[0].email === 'dealer@example.test'
  && calls[1].transactionalId === 'tid-buyer' && calls[1].email === 'buyer@example.test' && db.st.sent.length === 3, JSON.stringify(out));
db = fakeDb(notices()); calls = [];
out = await runHoldNotices(db, { fetchImpl: async () => new Response('no', { status: 500 }) });
check('Loops error: not marked, tried again next run', out.failed === 2 && db.st.sent.length === 1);

// hold-notify-now
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_KEY = 'y';
db = fakeDb(notices(), { dealer: [R1] }); calls = [];
let r = await handle({ httpMethod: 'POST', headers: { authorization: 'Bearer tok-dealer' }, body: JSON.stringify({ reservation_id: R1 }) }, { db, fetchImpl: loops(calls) });
check('notify now: party gets only that hold sent', r.statusCode === 200 && calls.length === 1 && db.st.dueArgs[0].p_reservation_id === R1, r.body);
r = await handle({ httpMethod: 'POST', headers: { authorization: 'Bearer tok-x' }, body: JSON.stringify({ reservation_id: R1 }) }, { db });
check('notify now: someone else gets 404', r.statusCode === 404);
r = await handle({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ reservation_id: R1 }) }, { db });
check('notify now: signed out gets 401', r.statusCode === 401);
r = await handle({ httpMethod: 'POST', headers: { authorization: 'Bearer tok-dealer' }, body: '{"reservation_id":"nope"}' }, { db });
check('notify now: bad id refused', r.statusCode === 400);

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
