// Offer emails (Marketplace "Make an Offer", see CLAUDE.md "Offers"). Reads offer_notices_due(), sends each
// through Loops, then marks it with offer_notice_sent(). Reuses the two hold emails ("Hold - Dealer" /
// "Hold - Buyer", LOOPS_HOLD_DEALER_ID / LOOPS_HOLD_BUYER_ID): their text is all in the data variables
// (headline, message, cardList, actionUrl, actionLabel; plus buyerName, buyerContact, buyerNote, holdEnds on the
// dealer email). Without LOOPS_API_KEY or an email's id nothing is marked sent (it goes out once email is set
// up, while it's less than 2 days old).

const { whenText } = require('./hold-notices');

const SITE = () => (process.env.MARKETPLACE_SITE_URL || 'https://getcardshow.com').replace(/\/$/, '');
const money = c => (c == null ? '' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);

// → { templateEnv, vars } or null when there's nothing to say.
function compose(n) {
  const card = n.card || n.cards?.[0] || {};
  const cards = n.cards?.length ? n.cards : [card];
  const count = n.card_count || cards.length;
  // A bundle (several cards for one price) reads as "Charizard and 2 more cards".
  const title = count > 1 ? `${card.title || 'a card'} and ${count - 1} more ${count === 2 ? 'card' : 'cards'}` : (card.title || 'your card');
  const dealer = n.dealer?.display_name || n.dealer?.handle || 'The dealer';
  const buyer = n.buyer_name || 'A buyer';
  const amount = money(n.amount_cents);
  const asking = money(n.asking_cents ?? card.price_cents);
  const line = c => `${c.stock_code ? c.stock_code + ' · ' : ''}${c.title} · ${money(c.price_cents)}`;
  const cardList = count > 1 ? `${cards.map(line).join('\n')}\n${count} cards, asking ${asking} together`
                             : `${card.stock_code ? card.stock_code + ' · ' : ''}${card.title || 'your card'} · asking ${asking}`;
  const listingUrl = card.url ? SITE() + card.url : `${SITE()}/search`;
  const answerBy = whenText(n.expires_at);
  const holdEnds = whenText(n.hold_expires_at);

  if (n.to === 'dealer') {
    const vars = { cardList, buyerName: n.buyer_name || '', buyerContact: n.buyer_contact || '', buyerNote: n.buyer_note || '',
                   holdEnds: n.kind === 'accepted' ? holdEnds : '', actionUrl: `${SITE()}/app`, actionLabel: 'Open CardShow' };
    if (n.kind === 'new') return { templateEnv: 'LOOPS_HOLD_DEALER_ID', vars: { ...vars,
      headline: `${buyer} offered ${amount} for ${title}`,
      message: `You're asking ${asking}. Accept, decline or counter under Offers in the CardShow app by ${answerBy}. `
        + 'If you accept, the card is held for them for 24 hours and they pay you when you meet.' } };
    if (n.kind === 'countered') return { templateEnv: 'LOOPS_HOLD_DEALER_ID', vars: { ...vars,
      headline: `${buyer} countered at ${amount}`,
      message: `${buyer} answered your counter on ${title} with ${amount}. Accept or decline under Offers in the CardShow app by ${answerBy}.` } };
    if (n.kind === 'accepted') return { templateEnv: 'LOOPS_HOLD_DEALER_ID', vars: { ...vars,
      headline: n.decided_by === 'auto' ? `Offer accepted automatically: ${amount} for ${title}` : `${buyer} accepted ${amount} for ${title}`,
      message: (n.decided_by === 'auto' ? `${buyer}'s offer met your auto-accept price. ` : '')
        + `The card is on hold for ${buyer} until ${holdEnds}. Contact them at ${n.buyer_contact} to arrange payment and pickup. `
        + 'When they pay, tap "Sold to them" under Holds in the CardShow app.' } };
    if (n.kind === 'declined') return { templateEnv: 'LOOPS_HOLD_DEALER_ID', vars: { ...vars,
      headline: `${buyer} passed on your counter`,
      message: `${buyer} declined ${amount} for ${title}. The card stays on sale.` } };
    if (n.kind === 'expired') return { templateEnv: 'LOOPS_HOLD_DEALER_ID', vars: { ...vars,
      headline: `${buyer} didn't answer your counter`,
      message: `Your counter of ${amount} on ${title} ran out. The card stays on sale.` } };
    return null;
  }

  // to the buyer
  const vars = { cardList, actionUrl: listingUrl, actionLabel: 'See the card' };
  if (n.kind === 'countered') return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: { ...vars,
    headline: `${dealer} countered at ${amount}`,
    message: `${dealer} answered your offer on ${title} with ${amount}. Accept, decline${n.moves < 3 ? ' or counter' : ''} on the card's page by ${answerBy}.`,
    actionLabel: 'Answer the counter' } };
  if (n.kind === 'accepted') return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: { ...vars,
    headline: `${dealer} accepted ${amount}`,
    message: `${title} is on hold for you at ${amount} until ${holdEnds}. Pay ${dealer} when you meet, at their table or however you arrange. Nothing is charged on CardShow.` } };
  if (n.kind === 'declined') return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: { ...vars,
    headline: 'Your offer was declined',
    message: `${dealer} declined ${amount} for ${title}. It's still for sale at ${asking}.` } };
  if (n.kind === 'expired') return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: { ...vars,
    headline: 'Your offer ran out',
    message: `${dealer} didn't answer your offer of ${amount} for ${title} in time. You can make a new offer if it's still for sale.` } };
  if (n.kind === 'closed') return { templateEnv: 'LOOPS_HOLD_BUYER_ID', vars: { ...vars,
    headline: 'A card you made an offer on is no longer available',
    message: `${title} was sold or set aside for someone else, so your offer of ${amount} is closed.`,
    actionUrl: `${SITE()}/search`, actionLabel: 'Find more cards' } };
  return null;
}

async function runOfferNotices(db, { offerId = null, fetchImpl = fetch, budgetMs = 8000, now = () => Date.now(), log = console } = {}) {
  const started = now();
  const out = { due: 0, emailed: 0, skipped: 0, failed: 0, waiting: 0 };
  const { data: due, error } = await db.rpc('offer_notices_due', { p_limit: 100, p_offer_id: offerId });
  if (error) throw new Error(`offer_notices_due: ${error.message}`);
  const key = process.env.LOOPS_API_KEY;
  for (const n of due || []) {
    if (now() - started > budgetMs) break;
    out.due += 1;
    const mail = compose(n);
    if (!mail || !n.email) {
      await db.rpc('offer_notice_sent', { p_event_id: n.event_id });
      out.skipped += 1; continue;
    }
    const tid = process.env[mail.templateEnv];
    if (!key || !tid) { out.waiting += 1; log.log?.(`[offer-notices] email not set up (${mail.templateEnv}); kept for later`); continue; }
    try {
      const r = await fetchImpl('https://app.loops.so/api/v1/transactional', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionalId: tid, email: n.email, dataVariables: mail.vars }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) { out.failed += 1; continue; }
    } catch { out.failed += 1; continue; }
    await db.rpc('offer_notice_sent', { p_event_id: n.event_id });
    out.emailed += 1;
  }
  return out;
}

module.exports = { runOfferNotices, compose };
