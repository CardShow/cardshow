// Order emails: netlify/lib/order-notices.js and netlify/functions/order-notify-now.js, with Supabase and Loops stubbed.
//   node order-notices.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { runOrderNotices, compose, paymentLines } = require('../../netlify/lib/order-notices.js');
const { handle } = require('../../netlify/functions/order-notify-now.js')._test;

let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); };
const card = { id: 'a1', title: '2024 Prizm Jayden Daniels Silver', price_cents: 10000, stock_code: 'S-12', url: '/c/a1-jayden' };
const O1 = '11111111-1111-4111-8111-111111111111';
const payment = { methods: [{ kind: 'venmo', value: 'dealer-a' }, { kind: 'paypal', value: 'DealerA' }, { kind: 'cashapp', value: 'dealera' },
  { kind: 'zelle', value: 'a@example.test' }, { kind: 'other', value: 'Cash at the table' }], note: 'Put the order # in the note' };
const base = { order_id: O1, buyer_name: 'Cal', buyer_contact: 'c@x.test', fulfillment: 'ship', subtotal_cents: 10000, shipping_cents: 500,
  total_cents: 10500, confirm_by: '2026-11-24T23:00:00Z', pay_by: '2026-11-25T23:00:00Z',
  ship_to: { name: 'Cal B', line1: '1 Main St', city: 'Austin', state: 'TX', postal: '78701' },
  dealer: { handle: 'dealer_a', display_name: 'Dealer A' }, cards: [card], card_count: 1, payment };
const rows = () => [
  { ...base, event_id: 'e1', kind: 'new', to: 'dealer', email: 'dealer@example.test' },
  { ...base, event_id: 'e2', kind: 'confirmed', to: 'buyer', email: 'buyer@example.test', status: 'awaiting_payment' },
  { ...base, event_id: 'e3', kind: 'shipped', to: 'buyer', email: 'buyer@example.test', carrier: 'USPS', tracking_number: '9400 1' },
  { ...base, event_id: 'e4', kind: 'cancelled', to: 'buyer', email: null, end_reason: 'not_available' },
];
function fakeDb(due, users = {}) {
  const st = { sent: [], args: [] };
  return { st,
    rpc: async (name, args) => {
      if (name === 'order_notices_due') { st.args.push(args); return { data: args.p_order_id ? due.filter(r => r.order_id === args.p_order_id) : due }; }
      if (name === 'order_notice_sent') { st.sent.push(args.p_event_id); return { data: null }; }
      if (name === 'order_party') return { data: users[args.p_user]?.includes(args.p_order_id) || false };
      return { data: null };
    },
    auth: { getUser: async t => (t === 'tok-buyer' ? { data: { user: { id: 'buyer' } } } : t === 'tok-x' ? { data: { user: { id: 'x' } } } : { error: { message: 'bad' } }) },
  };
}
const loops = calls => async (url, opts) => { calls.push(JSON.parse(opts.body)); return new Response('{}', { status: 200 }); };

const lines = paymentLines(payment, 10500);
check('payment links prefilled with the total', lines[0] === 'Venmo: https://venmo.com/dealer-a?txn=pay&amount=105.00'
  && lines[1] === 'PayPal: https://paypal.me/DealerA/105.00' && lines[2] === 'Cash App: https://cash.app/$dealera/105.00'
  && lines[3] === 'Zelle: a@example.test' && lines[4] === 'Cash at the table', JSON.stringify(lines));
const n = compose(rows()[0]);
check('new order → dealer: price, shipping, deadline, address, app link', n.templateEnv === 'LOOPS_HOLD_DEALER_ID'
  && n.vars.headline === 'New order: Cal bought 2024 Prizm Jayden Daniels Silver' && /\$100 \(\$5 shipping\)/.test(n.vars.message)
  && /Ship to: Cal B, 1 Main St, Austin, TX 78701/.test(n.vars.message) && n.vars.buyerContact === 'c@x.test'
  && n.vars.actionUrl === 'https://getcardshow.com/app', JSON.stringify(n));
check('new order, shipping not set → dealer is told to set it', /shipping to be set by you/.test(compose({ ...rows()[0], shipping_cents: null }).vars.message));
const c = compose(rows()[1]);
check("confirmed → buyer: total, the dealer's payment links, note, deadline, no charge", c.templateEnv === 'LOOPS_HOLD_BUYER_ID'
  && c.vars.headline === 'Dealer A confirmed your order' && /Pay \$105 to Dealer A: Venmo: https:\/\/venmo\.com\/dealer-a/.test(c.vars.message)
  && /Put the order # in the note/.test(c.vars.message) && /doesn't charge you/.test(c.vars.message)
  && c.vars.actionUrl === 'https://getcardshow.com/account#orders' && /Total \$105/.test(c.vars.cardList), JSON.stringify(c));
const p = compose({ ...rows()[1], fulfillment: 'local_pickup', shipping_cents: null, total_cents: 10000, pickup_show: { name: 'Near Show' } });
check('confirmed pickup → pay at pickup or now', /Pay Dealer A \$100 at pickup at Near Show, or now: Venmo/.test(p.vars.message), p.vars.message);
check('confirmed, no payment methods → contact the dealer', /Contact Dealer A to pay \$105/.test(compose({ ...rows()[1], payment: null }).vars.message));
check('shipped → buyer: carrier and tracking', /with USPS\. Tracking: 9400 1/.test(compose(rows()[2]).vars.message));
check('cancelled → buyer: why', /doesn't have 2024 Prizm Jayden Daniels Silver any more/.test(compose(rows()[3]).vars.message)
  && /sold at Dealer A's table/.test(compose({ ...rows()[3], end_reason: 'sold_elsewhere' }).vars.message));
check('expired → dealer: not confirmed mentions standing', /keeps your standing/.test(compose({ ...rows()[0], kind: 'expired', end_reason: 'not_confirmed' }).vars.message));
check('bundle → "and 1 more card"', compose({ ...rows()[0], cards: [card, { ...card, id: 'a2', title: 'Wemby' }], card_count: 2 }).vars.headline.endsWith('and 1 more card'));

process.env.LOOPS_API_KEY = 'k'; process.env.LOOPS_HOLD_DEALER_ID = 'tid-d'; process.env.LOOPS_HOLD_BUYER_ID = 'tid-b';
let calls = [];
let db = fakeDb(rows());
let out = await runOrderNotices(db, { fetchImpl: loops(calls) });
check('run: 3 emailed, the one with no email skipped and marked', out.emailed === 3 && out.skipped === 1 && db.st.sent.length === 4
  && calls[0].transactionalId === 'tid-d' && calls[1].transactionalId === 'tid-b' && calls[1].email === 'buyer@example.test', JSON.stringify(out));
delete process.env.LOOPS_HOLD_BUYER_ID;
calls = []; db = fakeDb(rows());
out = await runOrderNotices(db, { fetchImpl: loops(calls), log: {} });
check('no buyer template id → buyer emails wait, not marked sent', out.waiting === 2 && !db.st.sent.includes('e2') && db.st.sent.includes('e1'));
process.env.LOOPS_HOLD_BUYER_ID = 'tid-b';

db = fakeDb(rows(), { buyer: [O1] });
check('notify-now: needs a session', (await handle({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ order_id: O1 }) }, { db })).statusCode === 401);
check('notify-now: not a party → 404', (await handle({ httpMethod: 'POST', headers: { authorization: 'Bearer tok-x' }, body: JSON.stringify({ order_id: O1 }) }, { db })).statusCode === 404);
calls = [];
const r = await handle({ httpMethod: 'POST', headers: { authorization: 'Bearer tok-buyer' }, body: JSON.stringify({ order_id: O1 }) }, { db, fetchImpl: loops(calls) });
check("notify-now: party → only that order's emails sent", r.statusCode === 200 && db.st.args.at(-1).p_order_id === O1 && calls.length === 3);

console.log(fails ? `${fails} FAILED` : 'all passed');
if (fails) process.exit(1);
