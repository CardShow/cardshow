// Offer emails: netlify/lib/offer-notices.js and netlify/functions/offer-notify-now.js, with Supabase and Loops stubbed.
//   node offer-notices.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { runOfferNotices, compose } = require('../../netlify/lib/offer-notices.js');
const { handle } = require('../../netlify/functions/offer-notify-now.js')._test;

let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); };
const card = { id: 'a1', title: '1999 Pokemon Base Set Charizard Holo PSA 10', price_cents: 18000, stock_code: 'S-12', url: '/c/a1-charizard' };
const O1 = '11111111-1111-4111-8111-111111111111';
const base = { offer_id: O1, buyer_name: 'Alex', buyer_contact: '555-0100', buyer_note: 'Cash', amount_cents: 15000, asking_cents: 18000,
  offer_cents: 15000, moves: 1, expires_at: '2026-11-24T23:00:00Z', dealer: { handle: 'dealer_a', display_name: 'Dealer A' }, card };
const rows = () => [
  { ...base, event_id: 'e1', kind: 'new', to: 'dealer', email: 'dealer@example.test' },
  { ...base, event_id: 'e2', kind: 'countered', to: 'buyer', email: 'buyer@example.test', amount_cents: 17000, moves: 2 },
  { ...base, event_id: 'e3', kind: 'accepted', to: 'buyer', email: 'buyer@example.test', amount_cents: 16000, decided_by: 'dealer', hold_expires_at: '2026-11-25T23:00:00Z' },
  { ...base, event_id: 'e4', kind: 'closed', to: 'buyer', email: null },
];
function fakeDb(due, users = {}) {
  const st = { sent: [], args: [] };
  return { st,
    rpc: async (name, args) => {
      if (name === 'offer_notices_due') { st.args.push(args); return { data: args.p_offer_id ? due.filter(r => r.offer_id === args.p_offer_id) : due }; }
      if (name === 'offer_notice_sent') { st.sent.push(args.p_event_id); return { data: null }; }
      if (name === 'offer_party') return { data: users[args.p_user]?.includes(args.p_offer_id) || false };
      return { data: null };
    },
    auth: { getUser: async t => (t === 'tok-buyer' ? { data: { user: { id: 'buyer' } } } : t === 'tok-x' ? { data: { user: { id: 'x' } } } : { error: { message: 'bad' } }) },
  };
}
const loops = calls => async (url, opts) => { calls.push(JSON.parse(opts.body)); return new Response('{}', { status: 200 }); };

const n = compose(rows()[0]);
check('new offer → dealer: amount, asking, contact, app link', n.templateEnv === 'LOOPS_HOLD_DEALER_ID' && n.vars.headline === 'Alex offered $150 for 1999 Pokemon Base Set Charizard Holo PSA 10'
  && /asking \$180/.test(n.vars.message) && n.vars.buyerContact === '555-0100' && n.vars.holdEnds === '' && n.vars.actionUrl === 'https://getcardshow.com/app', JSON.stringify(n));
const c = compose(rows()[1]);
check('counter → buyer: amount, can counter back, link to the card', c.templateEnv === 'LOOPS_HOLD_BUYER_ID' && c.vars.headline === 'Dealer A countered at $170'
  && /or counter/.test(c.vars.message) && c.vars.actionUrl === 'https://getcardshow.com/c/a1-charizard');
check('last counter → buyer: no "or counter"', !/or counter/.test(compose({ ...rows()[1], moves: 3 }).vars.message));
const a = compose(rows()[2]);
check('accepted → buyer: on hold at the price, until when, pay when you meet', /\$160/.test(a.vars.headline) && /on hold for you at \$160 until .*Pacific/.test(a.vars.message)
  && /Nothing is charged/.test(a.vars.message));
const auto = compose({ ...rows()[2], to: 'dealer', decided_by: 'auto' });
check('auto-accepted → dealer: says so, hold end, contact', /accepted automatically/.test(auto.vars.headline) && /Pacific/.test(auto.vars.holdEnds)
  && /555-0100/.test(auto.vars.message) && /Sold to them/.test(auto.vars.message));
check('declined / expired / closed copy', /declined \$150/.test(compose({ ...base, kind: 'declined', to: 'buyer' }).vars.message)
  && /didn't answer/.test(compose({ ...base, kind: 'expired', to: 'buyer' }).vars.message)
  && /didn't answer your counter/.test(compose({ ...base, kind: 'expired', to: 'dealer' }).vars.headline)
  && compose({ ...base, kind: 'closed', to: 'buyer' }).vars.actionUrl.endsWith('/search'));

delete process.env.LOOPS_API_KEY;
let db = fakeDb(rows()), calls = [];
let out = await runOfferNotices(db, { fetchImpl: loops(calls), log: {} });
check('Loops not set up: emails wait, no-address rows still marked', out.waiting === 3 && out.skipped === 1 && calls.length === 0
  && db.st.sent.join() === 'e4', JSON.stringify(out));

process.env.LOOPS_API_KEY = 'k'; process.env.LOOPS_HOLD_DEALER_ID = 'tid-dealer'; process.env.LOOPS_HOLD_BUYER_ID = 'tid-buyer';
db = fakeDb(rows()); calls = [];
out = await runOfferNotices(db, { fetchImpl: loops(calls) });
check('set up: three emails to the right people, all marked', out.emailed === 3 && out.skipped === 1 && calls[0].transactionalId === 'tid-dealer'
  && calls[0].email === 'dealer@example.test' && calls[1].transactionalId === 'tid-buyer' && db.st.sent.length === 4, JSON.stringify(out));
db = fakeDb(rows()); calls = [];
out = await runOfferNotices(db, { fetchImpl: async () => new Response('no', { status: 500 }) });
check('Loops error: nothing marked, tried next run', out.failed === 3 && db.st.sent.join() === 'e4');

const ev = (body, tok) => ({ httpMethod: 'POST', headers: tok ? { authorization: 'Bearer ' + tok } : {}, body: JSON.stringify(body) });
db = fakeDb(rows(), { buyer: [O1] }); calls = [];
let r = await handle(ev({ offer_id: O1 }, 'tok-buyer'), { db, fetchImpl: loops(calls) });
check('notify-now: a party sends that offer\'s emails', r.statusCode === 200 && JSON.parse(r.body).emailed === 3 && db.st.args[0].p_offer_id === O1);
r = await handle(ev({ offer_id: O1 }, 'tok-x'), { db, fetchImpl: loops(calls) });
check('notify-now: someone else gets 404', r.statusCode === 404);
r = await handle(ev({ offer_id: O1 }), { db });
check('notify-now: signed out 401, bad id 400, GET 405', r.statusCode === 401
  && (await handle(ev({ offer_id: 'x' }, 'tok-buyer'), { db })).statusCode === 400
  && (await handle({ httpMethod: 'GET' }, { db })).statusCode === 405);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
