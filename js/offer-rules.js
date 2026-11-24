// CardShow Marketplace — dealer offer rules (Phase 2). See CLAUDE.md "Dealer offer rules".
// A dealer sets once, for all their listings: decline offers below X% of asking (or of the online comp),
// counter in between at Y% of asking, accept at Z% of asking and up, and optionally nothing automatic
// while they're at a show. The server applies them (make_bundle_offer / _offer_auto,
// 20261211120000_marketplace_offer_rules.sql); a card's own lowest-offer / auto-accept prices win, and a
// card can opt out (inventory.use_offer_rules). Every automatic decision is in offers.auto_log, shown in the
// Offers panel (orAutoText()).
// Loaded after js/marketplace-offers.js. Shown only with the marketplace switch on (mkEnabled()).

let _orRules = null;      // dealer_offer_rules row, or null (none yet)
let _orMissing = false;   // migration not run yet
let _orLoaded = false;

async function orLoad() {
  if (typeof db === 'undefined' || !db || currentRole !== 'seller') return;
  try {
    const { data, error } = await db.from('dealer_offer_rules')
      .select('decline_below_pct, decline_basis, counter_pct, accept_at_pct, no_auto_at_show, updated_at').maybeSingle();
    if (error) {
      if (/dealer_offer_rules|PGRST205|42P01|schema cache/i.test(error.message || '') || error.code === '42P01') _orMissing = true;
      else console.warn('[offer rules]', error.message);
      return;
    }
    _orRules = data || null;
    _orLoaded = true;
  } catch (e) { console.warn('[offer rules]', e); }
}
function orReset() { _orRules = null; _orMissing = false; _orLoaded = false; document.getElementById('orOverlay')?.classList.remove('open'); }
function orRules() { return _orRules; }
function orHasRules(r = _orRules) {
  return !!(r && (r.decline_below_pct != null || r.counter_pct != null || r.accept_at_pct != null));
}

const _orNum = v => (v == null || v === '') ? null : Number(v);
const _orPct = v => `${Number(v)}%`;

// "Decline under 80% of asking · counter at 90% · accept at 95% and up"
function orSummaryText(r = _orRules) {
  if (!orHasRules(r)) return 'No offer rules yet: every offer waits for you.';
  const parts = [];
  if (r.decline_below_pct != null) parts.push(`decline under ${_orPct(r.decline_below_pct)} of ${r.decline_basis === 'comp' ? 'the online comp' : 'asking'}`);
  if (r.counter_pct != null) parts.push(`counter at ${_orPct(r.counter_pct)} of asking`);
  if (r.accept_at_pct != null) parts.push(`accept at ${_orPct(r.accept_at_pct)} of asking and up`);
  const s = parts.join(' · ');
  return s.charAt(0).toUpperCase() + s.slice(1) + (r.no_auto_at_show ? ' · nothing automatic while you\'re at a show' : '');
}

// One card's lines, as the server works them out (_offer_terms). Comp only when it's shown to buyers.
function orCompVisible(card) {
  const comp = card.CompValueCents;
  const price = Math.round((parseFloat(card.Price) || 0) * 100);
  if (!comp || !(price > 0)) return null;
  const st = card.PricingMatchStatus, ratio = price / comp;
  if (st === 'manual' || (st === 'matched' && ratio >= 0.2 && ratio <= 5)) return comp;
  return null;
}
function orCardTerms(card, opts = {}) {
  const r = _orRules;
  const price = opts.priceCents != null ? opts.priceCents : Math.round((parseFloat(card.Price) || 0) * 100);
  const useRules = (opts.useRules != null ? opts.useRules : card.UseOfferRules !== false) && orHasRules(r);
  const ownMin = opts.minCents !== undefined ? opts.minCents : card.MinOfferCents;
  const ownAuto = opts.autoCents !== undefined ? opts.autoCents : card.AutoAcceptCents;
  let min = ownMin != null ? ownMin : null, auto = ownAuto != null ? ownAuto : null, counter = null;
  if (useRules) {
    if (min == null && r.decline_below_pct != null) {
      const base = r.decline_basis === 'comp' ? orCompVisible(card) : price;
      if (base) min = Math.ceil(base * r.decline_below_pct / 100);
    }
    if (auto == null && r.accept_at_pct != null && price > 0) auto = Math.ceil(price * r.accept_at_pct / 100);
    if (r.counter_pct != null && price > 0) counter = Math.round(price * r.counter_pct / 10000) * 100;
    if (counter != null && auto != null) counter = Math.min(counter, auto);   // never counter above the accept line
  }
  return { price, min, auto, counter, useRules,
           minFromRule: ownMin == null && min != null, autoFromRule: ownAuto == null && auto != null,
           compMissing: useRules && r.decline_basis === 'comp' && r.decline_below_pct != null && ownMin == null && min == null };
}

// What happens to an offer on this card, in a line:
// "Under $80 declined · $80 to $89.99 countered at $90 · $90 to $94.99 wait for you · $95 and up accepted."
function orTermsLine(t) {
  const m = typeof _mkMoney === 'function' ? _mkMoney : c => '$' + (c / 100).toFixed(2);
  if (!(t.price > 0)) return '';
  const parts = [];
  const lo = t.min && t.min < t.price ? t.min : 0;
  if (lo) parts.push(`under ${m(lo)} declined`);
  const acc = t.auto != null && t.auto < t.price ? t.auto : t.price;
  let waitFrom = lo;
  if (t.useRules && t.counter != null && t.counter > lo && t.counter <= acc) {
    parts.push(`${lo ? m(lo) + ' to ' : 'up to '}${m(t.counter - 1)} countered at ${m(t.counter)}`);
    waitFrom = t.counter;
  }
  if (waitFrom < acc) parts.push(`${waitFrom ? m(waitFrom) + ' to ' : 'up to '}${m(acc - 1)} wait for you`);
  parts.push(acc < t.price ? `${m(acc)} and up accepted` : `full price (${m(t.price)}) accepted`);
  const s = parts.join(' · ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// ── Edit Card: "Use my offer rules on this card" + what it means for this card ──
function orCemFill(card) {
  const box = document.getElementById('cem_mk_rules_box');
  if (!box) return;
  box.style.display = _orMissing ? 'none' : '';
  const cb = document.getElementById('cem_mk_rules');
  if (cb) cb.checked = card.UseOfferRules !== false;
  orCemLine();
}
function orCemLine() {
  const el = document.getElementById('cem_mk_rules_line');
  if (!el) return;
  const id = document.getElementById('cem_mk_details')?.dataset.dbid;
  const card = id ? inventory.find(c => c._dbId === id) : null;
  if (!card) { el.textContent = ''; return; }
  const dollars = i => { const v = (document.getElementById(i)?.value || '').trim(); return v === '' ? null : Math.round(Number(v) * 100); };
  const useRules = document.getElementById('cem_mk_rules')?.checked !== false;
  const priceCents = Math.round(Number(document.getElementById('cem_price')?.value || card.Price || 0) * 100);
  const t = orCardTerms(card, { priceCents, useRules, minCents: dollars('cem_mk_min'), autoCents: dollars('cem_mk_auto') });
  if (!orHasRules()) {
    el.innerHTML = `No offer rules yet. <button type="button" class="mk-link" onclick="openOfferRules()">Set offer rules</button>`;
    return;
  }
  const line = orTermsLine(t);
  el.innerHTML = (useRules ? '' : 'Your offer rules are off for this card. ')
    + _mkEsc(line || 'Every offer waits for you.')
    + (t.compMissing ? ' <span class="or-muted">No online comp for this card yet, so the decline rule doesn\'t apply.</span>' : '')
    + ` <button type="button" class="mk-link" onclick="openOfferRules()">Offer rules</button>`;
}
document.addEventListener('input', e => {
  if (['cem_mk_min', 'cem_mk_auto', 'cem_price'].includes(e.target && e.target.id)) orCemLine();
});

// ── The rules dialog ──
function openOfferRules() {
  if (_orMissing) { showToast('Offer rules are still being set up.', '#f59e0b'); return; }
  let ov = document.getElementById('orOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'orOverlay';
    ov.className = 'modal-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'orTitle');
    ov.addEventListener('click', e => { if (e.target === ov) closeOfferRules(); });
    document.body.appendChild(ov);
  }
  const r = _orRules || {};
  const v = x => x == null ? '' : String(Number(x));
  ov.innerHTML = `
    <div class="modal or-modal">
      <div class="modal-header">
        <div><div class="modal-player" id="orTitle">Offer rules</div>
          <div class="mh-sub">For all your listed cards. Leave a box empty to turn that rule off. A card's own lowest offer and auto-accept price (Edit Card) win over these.</div></div>
        <button class="modal-close" type="button" onclick="closeOfferRules()" aria-label="Close">✕</button>
      </div>
      <form class="modal-body" id="orForm" onsubmit="orSave(event)" oninput="orPreview()">
        <label class="or-row"><span class="or-label">Decline offers below</span>
          <span class="mk-pct"><input type="number" name="decline" inputmode="decimal" min="1" max="99" step="1" placeholder="Off" value="${v(r.decline_below_pct)}"><span>% of</span>
          <select name="basis" class="show-input or-basis">
            <option value="asking" ${r.decline_basis !== 'comp' ? 'selected' : ''}>asking price</option>
            <option value="comp" ${r.decline_basis === 'comp' ? 'selected' : ''}>online comp</option>
          </select></span></label>
        <label class="or-row"><span class="or-label">Counter offers in between at</span>
          <span class="mk-pct"><input type="number" name="counter" inputmode="decimal" min="1" max="99" step="1" placeholder="Off" value="${v(r.counter_pct)}"><span>% of asking</span></span></label>
        <label class="or-row"><span class="or-label">Accept offers at or above</span>
          <span class="mk-pct"><input type="number" name="accept" inputmode="decimal" min="1" max="99" step="1" placeholder="Off" value="${v(r.accept_at_pct)}"><span>% of asking</span></span></label>
        <label class="mk-check"><input type="checkbox" name="atshow" ${r.no_auto_at_show ? 'checked' : ''}>
          While I'm at a show, don't accept or counter automatically (so I can check the card first)</label>
        <div class="or-example" id="orExample" aria-live="polite"></div>
        <p class="mh-help">Comp-based declines only apply to cards with an online comp. Bundles use each card's lines added up. Every automatic answer is shown in Offers, with the rule that made it.</p>
        <div class="mo-err" id="orErr" role="alert"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="closeOfferRules()">Cancel</button>
          <button type="submit" class="btn btn-primary" id="orSaveBtn">Save rules</button>
        </div>
      </form>
    </div>`;
  ov.classList.add('open');
  orPreview();
}
function closeOfferRules() { document.getElementById('orOverlay')?.classList.remove('open'); }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('orOverlay')?.classList.contains('open')) closeOfferRules();
});

function _orReadForm() {
  const f = document.getElementById('orForm');
  const n = name => { const s = f.elements[name].value.trim(); return s === '' ? null : Number(s); };
  return { decline_below_pct: n('decline'), decline_basis: f.elements.basis.value, counter_pct: n('counter'),
           accept_at_pct: n('accept'), no_auto_at_show: f.elements.atshow.checked };
}
// Same checks as set_offer_rules(). Returns an error message or ''.
function orValidate(r) {
  for (const k of ['decline_below_pct', 'counter_pct', 'accept_at_pct']) {
    if (r[k] != null && !(Number.isFinite(r[k]) && r[k] >= 1 && r[k] <= 99)) return 'Use percentages from 1 to 99 (leave a box empty to turn a rule off).';
  }
  if (r.counter_pct != null && r.accept_at_pct != null && r.counter_pct >= r.accept_at_pct) return 'The counter has to be below the accept line.';
  if (r.decline_basis === 'asking' && r.decline_below_pct != null) {
    if (r.counter_pct != null && r.counter_pct < r.decline_below_pct) return 'The counter can\'t be below the decline line.';
    if (r.accept_at_pct != null && r.accept_at_pct <= r.decline_below_pct) return 'The accept line has to be above the decline line.';
  }
  return '';
}
function orPreview() {
  const ex = document.getElementById('orExample');
  if (!ex) return;
  const r = _orReadForm();
  const err = orValidate(r);
  document.getElementById('orErr').textContent = err;
  if (err) { ex.textContent = ''; return; }
  if (!orHasRules(r)) { ex.textContent = 'No rules: every offer waits for you.'; return; }
  const saved = _orRules; _orRules = r;
  const t = orCardTerms({ Price: 100, CompValueCents: 10000, PricingMatchStatus: 'manual' }, { useRules: true });
  _orRules = saved;
  ex.textContent = `On a $100 card${r.decline_basis === 'comp' && r.decline_below_pct != null ? ' with a $100 comp' : ''}: ${orTermsLine(t).replace(/^./, c => c.toLowerCase())}`;
}

const OR_ERR = { bad_pct: 'Use percentages from 1 to 99.', bad_order: 'Keep the lines in order: decline, then counter, then accept.',
  bad_basis: 'Pick asking price or online comp.', not_a_seller: 'Only dealers can set offer rules.' };

async function orSave(e) {
  e.preventDefault();
  const r = _orReadForm();
  const err = orValidate(r);
  const errEl = document.getElementById('orErr');
  errEl.textContent = err;
  if (err) return;
  if (typeof _mkNeedSignal === 'function' && _mkNeedSignal()) return;
  const btn = document.getElementById('orSaveBtn');
  btn.disabled = true;
  try {
    const { data, error } = await db.rpc('set_offer_rules', { p_decline_pct: r.decline_below_pct, p_decline_basis: r.decline_basis,
      p_counter_pct: r.counter_pct, p_accept_pct: r.accept_at_pct, p_no_auto_at_show: r.no_auto_at_show });
    if (error) throw error;
    if (data && data.error) { errEl.textContent = OR_ERR[data.error] || 'Couldn\'t save. Try again.'; return; }
    _orRules = (data && data.rules) || r;
    closeOfferRules();
    showToast(orHasRules() ? 'Offer rules saved. New offers are answered by them.' : 'Offer rules off. Every offer waits for you.');
    orCemLine();
    if (document.getElementById('mkOverlay')?.classList.contains('open') && typeof _mkRenderPanel === 'function') _mkRenderPanel();
    if (document.getElementById('moOverlay')?.classList.contains('open') && typeof _moRenderPanel === 'function') _moRenderPanel();
  } catch (ex) {
    console.warn('[offer rules] save', ex);
    errEl.textContent = /set_offer_rules|PGRST202|schema cache/i.test(ex.message || '') ? 'Offer rules are still being set up.' : 'Couldn\'t save. Check your signal and try again.';
  } finally { btn.disabled = false; }
}

// ── Offers panel: why an offer was answered automatically ──
function orAutoText(e, cardCount = 1) {
  if (!e) return '';
  const m = typeof _mkMoney === 'function' ? _mkMoney : c => '$' + (c / 100).toFixed(2);
  const these = cardCount > 1 ? 'these cards\'' : 'this card\'s';
  if (e.action === 'accept') {
    if (e.rule === 'full_price') return 'Accepted automatically: the offer was your full asking price.';
    if (e.rule === 'rule_accept') return `Accepted automatically: the offer was ${e.pct_of_asking}% of asking (your rule accepts at ${e.rule_pct}%).`;
    return `Accepted automatically: at or above ${these} auto-accept price (${m(e.threshold_cents)}).`;
  }
  if (e.action === 'decline') {
    if (e.rule === 'rule_decline') return `Declined automatically: under ${e.rule_pct}% of ${e.basis === 'comp' ? 'the online comp' : 'asking'} (${m(e.threshold_cents)}).`;
    return `Declined automatically: under ${these} lowest offer (${m(e.threshold_cents)}).`;
  }
  if (e.action === 'counter') return `Countered automatically at ${m(e.counter_cents)}: your rule counters at ${e.rule_pct}% of asking.`;
  if (e.action === 'left_for_you') return `Left for you because you're at a show. Your rules would have ${e.would === 'accept' ? 'accepted it' : 'countered at ' + m(e.counter_cents)}.`;
  return '';
}
function orLastAuto(o) { const l = o && o.auto_log; return Array.isArray(l) && l.length ? l[l.length - 1] : null; }
