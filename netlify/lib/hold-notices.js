// Hold emails (Marketplace holds, see CLAUDE.md "Holds"). Reads hold_notices_due(), sends each through Loops,
// then marks it with hold_notice_sent(). Two Loops transactional emails with the same data variables:
//   LOOPS_HOLD_DEALER_ID  to the dealer: a buyer is holding a card / a buyer cancelled
//   LOOPS_HOLD_BUYER_ID   to the buyer: the dealer released it / it expired / it sold at the table
// Data variables: headline, message, cardList, actionUrl, actionLabel (both), plus buyerName, buyerContact, buyerNote,
// holdEnds (dealer email only). Created in Loops 2026-11-23 as "Hold - Dealer" / "Hold - Buyer".
// Without LOOPS_API_KEY or the email's id, nothing is marked sent (it goes out once email is set up, while
// still relevant: open holds, or holds that ended in the last 2 days).

const SITE = () => (process.env.MARKETPLACE_SITE_URL || 'https://getcardshow.com').replace(/\/$/, '');
const money = c => (c == null ? '' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);

function whenText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit' }) + ' Pacific';
}

function cardsText(n) {
  const cards = n.cards || [];
  return cards.map(c => `${c.stock_code ? c.stock_code + ' · ' : ''}${c.title} · ${money(c.price_cents)}`).join('\n');
}
function firstTitle(n) {
  const cards = n.cards || [];
  if (!cards.length) return 'your card';
  return cards.length === 1 ? cards[0].title : `${cards[0].title} and ${cards.length - 1} more`;
}

// → { templateEnv, vars } or null when nobody is emailed.
function compose(n) {
  const dealer = n.dealer?.display_name || n.dealer?.handle || 'The dealer';
  const buyer = n.buyer_name || 'A buyer';
  const title = firstTitle(n);
  const base = { cardList: cardsText(n), buyerName: n.buyer_name || '', buyerContact: n.buyer_contact || '',
                 buyerNote: n.buyer_note || '', holdEnds: whenText(n.expires_at) };
  const listingUrl = n.cards?.[0]?.url ? SITE() + n.cards[0].url : `${SITE()}/search`;
  if (n.kind === 'placed' && n.to === 'dealer') {
    return { templateEnv: 'LOOPS_HOLD_DEALER_ID', vars: { ...base,
      headline: `${buyer} is holding ${title}`,
      message: `${buyer} asked you to set this aside until ${base.holdEnds}. Contact them at ${n.buyer_contact} to arrange payment and pickup. `
        + 'If you sell it to them, tap "Sold to them" under Holds in the CardShow app. If you can\'t hold it, tap "Release".',
      actionUrl: `${SITE()}/app`, actionLabel: 'Open CardShow' } };
  }
  if (n.kind === 'ended' && n.to === 'dealer') {
    return { templateEnv: 'LOOPS_HOLD_DEALER_ID', vars: { ...base,
      headline: `${buyer} cancelled their hold`,
      message: `${buyer} no longer needs ${title}. It's back on sale on CardShow.`,
      actionUrl: `${SITE()}/app`, actionLabel: 'Open CardShow' } };
  }
  if (n.kind === 'ended' && n.to === 'buyer') {
    const why = n.end_reason === 'dealer_released' ? `${dealer} released your hold on ${title}. It's back on sale.`
      : n.end_reason === 'sold_elsewhere' ? `${dealer} recorded ${title} as sold at their table. If you bought it, you're all set. If not, it's no longer available.`
      : `Your hold on ${title} ended. If nobody else took it, you can hold it again.`;
    const headline = n.end_reason === 'sold_elsewhere' ? 'A card you were holding sold'
      : n.end_reason === 'dealer_released' ? 'Your hold was released' : 'Your hold ended';
    return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: { cardList: base.cardList, headline, message: why,
      actionUrl: n.end_reason === 'sold_elsewhere' ? `${SITE()}/search` : listingUrl,
      actionLabel: n.end_reason === 'sold_elsewhere' ? 'Find more cards' : 'See the card' } };
  }
  return null;
}

async function runHoldNotices(db, { reservationId = null, fetchImpl = fetch, budgetMs = 8000, now = () => Date.now(), log = console } = {}) {
  const started = now();
  const out = { due: 0, emailed: 0, skipped: 0, failed: 0, waiting: 0 };
  const { data: due, error } = await db.rpc('hold_notices_due', { p_limit: 100, p_reservation_id: reservationId });
  if (error) throw new Error(`hold_notices_due: ${error.message}`);
  const key = process.env.LOOPS_API_KEY;
  for (const n of due || []) {
    if (now() - started > budgetMs) break;
    out.due += 1;
    const mail = compose(n);
    if (!mail || !n.email) {   // nobody to email (sold to the holder, cancelled early, no address)
      await db.rpc('hold_notice_sent', { p_reservation_id: n.reservation_id, p_kind: n.kind });
      out.skipped += 1; continue;
    }
    const tid = process.env[mail.templateEnv];
    if (!key || !tid) { out.waiting += 1; log.log?.(`[hold-notices] email not set up (${mail.templateEnv}); kept for later`); continue; }
    try {
      const r = await fetchImpl('https://app.loops.so/api/v1/transactional', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionalId: tid, email: n.email, dataVariables: mail.vars }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) { out.failed += 1; continue; }   // tried again next run
    } catch { out.failed += 1; continue; }
    await db.rpc('hold_notice_sent', { p_reservation_id: n.reservation_id, p_kind: n.kind });
    out.emailed += 1;
  }
  return out;
}

module.exports = { runHoldNotices, compose, whenText };
