// Order emails (Marketplace "Buy Now", see CLAUDE.md "Buy Now and orders"). Reads order_notices_due(), sends each
// through Loops, then marks it with order_notice_sent(). Reuses the two hold emails ("Hold - Dealer" /
// "Hold - Buyer", LOOPS_HOLD_DEALER_ID / LOOPS_HOLD_BUYER_ID): all the text is in the data variables. Without
// LOOPS_API_KEY or an email's id nothing is marked sent (it goes out once email is set up, while it's less than
// 2 days old).

const { whenText } = require('./hold-notices');

const SITE = () => (process.env.MARKETPLACE_SITE_URL || 'https://getcardshow.com').replace(/\/$/, '');
const money = c => (c == null ? '' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);

// The dealer's payment methods as lines a buyer can act on (links prefilled with the amount where the service allows).
function paymentLines(payment, totalCents) {
  const amt = totalCents != null ? (totalCents / 100).toFixed(2) : '';
  return (payment?.methods || []).map(m => {
    const v = m.value;
    if (m.kind === 'venmo') return `Venmo: https://venmo.com/${encodeURIComponent(v)}?txn=pay&amount=${amt}`;
    if (m.kind === 'paypal') return `PayPal: https://paypal.me/${encodeURIComponent(v)}/${amt}`;
    if (m.kind === 'cashapp') return `Cash App: https://cash.app/$${encodeURIComponent(v)}/${amt}`;
    if (m.kind === 'zelle') return `Zelle: ${v}`;
    if (m.kind === 'link') return `Pay here: ${v}`;
    return v;
  });
}

// → { templateEnv, vars } or null when there's nothing to say.
function compose(n) {
  const cards = n.cards || [];
  const first = cards[0] || {};
  const count = n.card_count || cards.length || 1;
  const title = count > 1 ? `${first.title || 'a card'} and ${count - 1} more ${count === 2 ? 'card' : 'cards'}` : (first.title || 'your card');
  const dealer = n.dealer?.display_name || n.dealer?.handle || 'The dealer';
  const buyer = n.buyer_name || 'A buyer';
  const total = money(n.total_cents);
  const shipText = n.fulfillment === 'ship'
    ? (n.shipping_cents == null ? 'shipping to be set by you' : n.shipping_cents ? `${money(n.shipping_cents)} shipping` : 'free shipping')
    : `pickup${n.pickup_show?.name ? ' at ' + n.pickup_show.name : ''}`;
  const line = c => `${c.stock_code ? c.stock_code + ' · ' : ''}${c.title} · ${money(c.price_cents)}`;
  const cardList = [...cards.map(line), `Total ${total}${n.fulfillment === 'ship' && n.shipping_cents == null ? ' + shipping' : ''}`].join('\n');
  const orderUrl = `${SITE()}/account#orders`;

  if (n.to === 'dealer') {
    const addr = n.ship_to ? [n.ship_to.name, n.ship_to.line1, n.ship_to.line2, `${n.ship_to.city}, ${n.ship_to.state} ${n.ship_to.postal}`].filter(Boolean).join(', ') : '';
    const vars = { cardList, buyerName: n.buyer_name || '', buyerContact: n.buyer_contact || '', buyerNote: n.buyer_note || '',
                   holdEnds: '', actionUrl: `${SITE()}/app`, actionLabel: 'Open CardShow' };
    if (n.kind === 'new') return { templateEnv: 'LOOPS_HOLD_DEALER_ID', vars: { ...vars,
      headline: `New order: ${buyer} bought ${title}`,
      message: `${buyer} wants to buy ${title} for ${money(n.subtotal_cents)} (${shipText}). Confirm you still have it under Orders in the CardShow app by ${whenText(n.confirm_by)}, or it's cancelled and the card goes back on sale.`
        + (addr ? ` Ship to: ${addr}.` : '') } };
    if (n.kind === 'cancelled') return { templateEnv: 'LOOPS_HOLD_DEALER_ID', vars: { ...vars,
      headline: `${buyer} cancelled their order`, message: `${buyer} cancelled the order for ${title}. The card is back on sale.` } };
    if (n.kind === 'expired') return { templateEnv: 'LOOPS_HOLD_DEALER_ID', vars: { ...vars,
      headline: n.end_reason === 'not_paid' ? `${buyer} didn't pay in time` : `An order wasn't confirmed in time`,
      message: n.end_reason === 'not_paid'
        ? `The order for ${title} ran out without being marked paid, so it's cancelled and the card is back on sale. If ${buyer} did pay you, contact them at ${n.buyer_contact}.`
        : `${buyer}'s order for ${title} wasn't confirmed by ${whenText(n.confirm_by)}, so it's cancelled and the card is back on sale. Confirming quickly keeps your standing on CardShow.` } };
    return null;
  }

  // to the buyer
  const vars = { cardList, actionUrl: orderUrl, actionLabel: 'See your order' };
  if (n.kind === 'confirmed') {
    const pay = paymentLines(n.payment, n.total_cents);
    const howToPay = n.fulfillment === 'local_pickup'
      ? `Pay ${dealer} ${total} at pickup${n.pickup_show?.name ? ' at ' + n.pickup_show.name : ''}${pay.length ? ', or now: ' + pay.join(' · ') : ''}.`
      : (pay.length ? `Pay ${total} to ${dealer}: ${pay.join(' · ')}.` : `Contact ${dealer} to pay ${total}.`);
    return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: { ...vars,
      headline: `${dealer} confirmed your order`,
      message: `${title} is yours once you pay. ${howToPay}${n.payment?.note ? ' ' + n.payment.note : ''} Pay by ${whenText(n.pay_by)}. CardShow doesn't charge you anything.`,
      actionLabel: 'Pay now' } };
  }
  if (n.kind === 'paid') return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: { ...vars,
    headline: `${dealer} got your payment`,
    message: n.fulfillment === 'ship' ? `${dealer} marked your order for ${title} paid and will ship it. You'll get the tracking number by email.`
      : n.status === 'completed' ? `Your order for ${title} is complete. Enjoy the card!` : `${dealer} marked your order for ${title} paid. Pick it up from them as arranged.` } };
  if (n.kind === 'shipped') return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: { ...vars,
    headline: `${title} has shipped`,
    message: `${dealer} shipped your order${n.carrier ? ' with ' + n.carrier : ''}. Tracking: ${n.tracking_number}. Tap "Got it" on your order when it arrives.` } };
  if (n.kind === 'cancelled') return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: { ...vars,
    headline: n.end_reason === 'not_paid' ? 'Your order was cancelled' : `${title} isn't available`,
    message: n.end_reason === 'sold_elsewhere' ? `${title} sold at ${dealer}'s table before your order went through, so it's cancelled. You haven't been charged.`
      : n.end_reason === 'not_paid' ? `${dealer} cancelled your order for ${title} because they didn't receive payment. If you did pay, contact them.`
      : n.end_reason === 'not_available' ? `${dealer} doesn't have ${title} any more, so your order is cancelled. You haven't been charged.`
      : `${dealer} cancelled your order for ${title}.`,
    actionUrl: `${SITE()}/search`, actionLabel: 'Find more cards' } };
  if (n.kind === 'expired') return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: { ...vars,
    headline: n.end_reason === 'not_paid' ? 'Your order ran out' : `${dealer} didn't confirm your order`,
    message: n.end_reason === 'not_paid' ? `Your order for ${title} wasn't marked paid in time, so it's cancelled. If you paid, contact ${dealer}.`
      : `${dealer} didn't confirm they still have ${title} in time, so your order is cancelled. You haven't been charged.`,
    actionUrl: `${SITE()}/search`, actionLabel: 'Find more cards' } };
  return null;
}

async function runOrderNotices(db, { orderId = null, fetchImpl = fetch, budgetMs = 8000, now = () => Date.now(), log = console } = {}) {
  const started = now();
  const out = { due: 0, emailed: 0, skipped: 0, failed: 0, waiting: 0 };
  const { data: due, error } = await db.rpc('order_notices_due', { p_limit: 100, p_order_id: orderId });
  if (error) throw new Error(`order_notices_due: ${error.message}`);
  const key = process.env.LOOPS_API_KEY;
  for (const n of due || []) {
    if (now() - started > budgetMs) break;
    out.due += 1;
    const mail = compose(n);
    if (!mail || !n.email) { await db.rpc('order_notice_sent', { p_event_id: n.event_id }); out.skipped += 1; continue; }
    const tid = process.env[mail.templateEnv];
    if (!key || !tid) { out.waiting += 1; log.log?.(`[order-notices] email not set up (${mail.templateEnv}); kept for later`); continue; }
    try {
      const r = await fetchImpl('https://app.loops.so/api/v1/transactional', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionalId: tid, email: n.email, dataVariables: mail.vars }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) { out.failed += 1; continue; }
    } catch { out.failed += 1; continue; }
    await db.rpc('order_notice_sent', { p_event_id: n.event_id });
    out.emailed += 1;
  }
  return out;
}

module.exports = { runOrderNotices, compose, paymentLines };
