# Seller Dashboard v2: decisions and spec amendments

Companion to "CardShow — Seller Dashboard Redesign — Build Spec v1" (Stephen, 2026-11-25). The spec itself
is not in the repo yet. This file records the decisions taken after Phase 0 and the sections of the spec
they replace. Where this file and the spec disagree, this file wins.

## Information architecture (replaces the spec's IA table)

| Desktop left nav | Phone tab bar, switch OFF | Phone tab bar, switch ON | Route |
|---|---|---|---|
| **+ Add cards** (gold button, top of nav) → `openQuickActions('add')` | Center **+** → Sell / Add sheet | Center **+** → Sell / Add sheet | — |
| Home | Home | Home | `#/s/home` (default after login) |
| Inventory *(count)* | Cards | Cards | `#/s/inventory` |
| Shows *(date chip ≤7 days out)* | Shows | Shows | `#/s/shows` |
| Marketplace *(badge)*, sub-items Listings / Offers & holds / Orders | not shown anywhere | **Market** tab, slot 5, tag icon (same as the desktop nav), badge | `#/s/market`, `#/s/market/buyers` |
| Sales & reports | More → Sales & reports | Home Sales / Net profit KPI cards; avatar menu row | `#/s/sales` |
| Footer: Table QR & storefront · Settings · Help & tour · account | More | Avatar menu (top right of phone Home) | `#/s/qr`, Profile modal |

"Switch" = `MARKETPLACE_UI_LAUNCHED` (or the `?marketplace=1` test switch, i.e. `mkEnabled()`).

## Decision: Marketplace on phone is its own tab, gated by the switch (open question 1, closed)

**Switch off:** the phone tab bar is exactly the spec and canvas: Home · Cards · + · Shows · More. Marketplace
appears nowhere. More and MMore stay as designed.

**Switch on:** slot 5 becomes **Market** in place of More.
- Icon: the tag icon used for Marketplace in the desktop nav.
- Route: `#/s/market/buyers`. It opens on the Buyers segment; Listings is the second segment.
- Badge: orders to confirm + orders to ship + offers to answer + holds ending within 24h
  (`ordToConfirm()`, the ship part of `ordToDo()`, `moWaiting()`, `mhActive()` by `expires_at`). This is the same
  count, from the same in-memory source, as the desktop nav badge and Home's Needs-you marketplace rows.
  No second poller.

**What More held, re-homed (switch on only):**
- Sales & reports: tapping Home's Sales / Net profit KPI cards opens `#/s/sales`, plus a "Sales & reports" row in
  the avatar menu.
- An avatar button (44×44) at the top right of the phone Home header opens a sheet with MMore's rows minus
  Marketplace: profile (`openProfile()`), Sales & reports, Table QR & storefront, Settings, Help & tour
  (the `#navHelpMenu` items), Sign out.
- Marketplace screens on phone have no back button (Market is a top-level tab). Sales keeps a back chevron,
  to Home.

**Listing stays an action on the card, not a reason to visit the tab:** the Cards select bar keeps
"List online", the "Listed online" saved view stays, Edit Card's Marketplace section is unchanged.

### Phase 7 acceptance criteria (added)
- [ ] Switch off: tabs are Home · Cards · + · Shows · More, and nothing on any phone screen mentions the marketplace.
- [ ] Switch on: tabs are Home · Cards · + · Shows · Market. The Market badge equals the desktop nav badge and
      Home's Needs-you marketplace rows.
- [ ] Switch on: every item MMore held can be reached in ≤2 taps from Home (avatar menu or KPI cards).

## Show Mode check (2026-11-25, report only; Show Mode not changed)

Show Mode covers the tab bar, so the Market badge isn't visible during a show. What a dealer in Show Mode sees today:
- **Toasts do show above Show Mode.** `#toast` is a direct child of `<body>`, `position: fixed`, `z-index: 999`,
  above `#showModeRoot` (150). Checked in headless Chromium at iPhone 13 size with Show Mode open.
  The pollers (`ordStart` / `moStart` / `mhStart`) aren't tied to the seller tab, so they keep running in Show Mode.
- **The strips do not show.** `#mhStrip`, `#moStrip`, `#ordStrip` are inside `#view-seller`, under Show Mode.
- **Gaps:** each new order / offer / hold toasts **once** (seen ids in localStorage), for **3 seconds**, can't be
  tapped (`pointer-events: none`), and says "Tap Orders" / "Tap Offers" / "Tap Holds", which don't exist in
  Show Mode. Orders poll every 60s; holds and offers every 2 min. With a 15-minute confirm window at a show, a
  missed toast leaves no reminder anywhere in Show Mode. Not changed; Stephen to decide.

## Open questions (replaces the spec's list)
1. ~~Phone tabs: Marketplace under More or its own tab?~~ **Closed 2026-11-25:** its own tab, gated by the
   marketplace switch (above).
2. Set baseline: Sales & reports card (as specced), Inventory bulk bar → More, or Settings?
3. Bulk "Add to show" and `activeShowId`: recommended yes. The bulk action reuses `sellerPublishToShow()`,
   which already acts on checked rows and already sets `activeShowId`.
4. Flag rollout: beta sellers first via `?seller_nav=1`, then everyone after the next show? **Still needs an
   answer from Stephen.**
5. May Phase 6 map `inventory.sold_channel` and `inventory.source` in `dbRowToCard()` (client only, no SQL) so
   marketplace sales and off-show manual sales can be told apart in "Where sales came from"?
6. Show Mode marketplace alerts: leave as is, or (a separate change to Show Mode) add a persistent notice there?
