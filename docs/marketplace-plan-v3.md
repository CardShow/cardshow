# CardShow Marketplace: Strategy and Build Plan v3

**Owner:** Stephen Wilhelm · **Date:** November 19, 2026
**Stack:**
- **Dealer app:** vanilla HTML/CSS/JS (`app.html`), unchanged for now
- **Buyer marketplace:** a separate site built on the server (Astro or Next.js, confirm with InfernoRed), deployed on Netlify
- **Shared by both:** Supabase (Postgres, Auth, Storage), Netlify Functions, Stripe Connect, Stripe Tax, Exemptax (resale certificates), Loops (email), Anthropic API
**Related:** Instagram Social Sales Ingest Spec v1, AuctionWire partnership, InfernoRed code review

> Saved into the repo on 2026-11-20 as the reference for building the marketplace. What has been
> built, and where the build differs from this plan, is recorded in CLAUDE.md under
> "CardShow Marketplace".

**What changed from v2** (decisions from the open-questions review):
- **Buyer marketplace is a separate site** sharing the same Supabase database and status functions; the dealer app stays in `app.html`.
- **Local pickup holds:** the full amount is held on the buyer's card and charged at pickup, with a no-show fee if the buyer doesn't come. Holds longer than 7 days are charged up front instead.
- **Returns follow eBay:** if a card isn't as described, the dealer pays return shipping and the buyer gets a full refund. Change-of-mind returns follow each dealer's policy (default: no returns), and the buyer pays shipping.
- **Lot disputes:** claims are made card by card using the cert list. The dealer offers a partial refund for the affected card or a full return of the lot, and neither side is forced into a partial refund.
- **Wholesale fee:** card processing only (ACH encouraged) until there are enough buyers and sellers, then a subscription.
- **Minimum lot size:** 5 cards by default, adjustable once repacker interviews are done.
- **Dealer standing:** a warning, then direct follow-up, then suspension, then a ban, with set triggers and a scorecard visible to each dealer.
- **Sales tax:** Stripe Tax for marketplaces, with Exemptax collecting resale certificates from wholesale buyers before any tax-exempt purchase.
- **Agent liability:** a starting position for the lawyer to review.
- New tables: `claims`, `dealer_standing`, `tax_exemptions`, `dealer_policies`.

**v2 changes (still included):** the wholesale model (lots, buy orders, Last Hour Lots, shipping to vaults) and agentic commerce (MCP server, dealer offer rules, repacker sourcing agent, Phase 6 agents, ACP checkout).

---

# Part 1: Strategy

## The concept in one line

**CardShow is the live inventory network for physical card shows and card shops:** dealers list once, and every card is available to local buyers at the show, to repackers and wholesale buyers before the doors open, to collectors anywhere, and to the AI agents working for all of them, at a fraction of eBay's fees.

## What makes it unique

Every other marketplace treats a card as an online listing. CardShow treats a card as **physical inventory with a place and a time**: a table at a show this Saturday, or a shelf at a card shop. That creates ways to buy that no competitor offers together.

| Buyer | What they get on CardShow | Why they can't get it elsewhere |
|---|---|---|
| **Local buyers** | "Cards you want, at a show 20 miles away this Saturday." Hold a card with a deposit and pick it up at the table. | eBay, Arena Club and Whatnot don't know what's on a show floor. |
| **Repackers, breakers and rip platforms** | First look at show inventory 48 hours early, lots of graded slabs with full cert lists, buy orders by value tier priced against comps, and Last Hour Lots at the end of each show. | Today they walk show aisles and buy table by table, or buy collections and distributor lots. No platform sources show inventory for them. |
| **Collectors anywhere** | Buy now or make an offer on cards that were never listed online, shipped by the dealer. | Most show inventory never reaches eBay. |
| **AI agents acting for any of the above** | Agents can search, hold, make offers and (later) buy through CardShow, within limits their owner sets. | Other agents can only search online listings. CardShow's agents can shop what's on show tables this weekend. |

**For dealers: more buyers, faster sales and lower fees.**

| | eBay | Arena Club | **CardShow** |
|---|---|---|---|
| Seller fee | 13.25% + per-order fee | 10% | **1% (launch rate)** |
| Buyers reached | Online only | Online only | **Local, wholesale, online and AI assistants** |
| Sells in bulk to repackers | No | No | **Yes, lots priced against comps** |
| Works with show and shop inventory | No | No | **Yes, list once, sell anywhere** |
| Seller controls each sale | Mostly automatic | Mostly automatic | **Dealer approves offers, or sets rules for an agent to handle them** |

## Why wholesale buyers are the starting point

Rip platforms and repackers need a constant supply of **graded slabs across a range of values**, mostly mid- and lower-value cards to fill pack tiers, plus a few high-value chase cards. They buy mostly **in bulk or in lots, below market**: collections at about 50–60% of market, groups of cards at a discount at shows, and graded lots from distributors. Their bottleneck is restocking everyday $25–$250 slabs, which show dealers have plenty of.

**What a dealer nets on a $100 card:**

| Channel | Price | Fees and costs | Dealer nets | Speed |
|---|---|---|---|---|
| eBay | $100 | 13.25% + $0.40, plus supplies, time, risk it doesn't sell | about $82–$86 | Days to weeks, one card at a time |
| **CardShow wholesale** | $85 (85% of comps) | 1% | **about $84** | **Right away, the whole lot at once** |

Selling wholesale on CardShow nets about what eBay does, without the listing work, shipping card by card, or waiting. That's the pitch to dealers who want their cards to sell fast.

## How we win

1. **Start where demand is guaranteed: wholesale buyers.** Their buy orders give dealers a buyer before the show starts, which gives dealers a reason to list.
2. **Make listing a competitive advantage.** Early-access and wholesale buyers only see dealers who listed, so dealers who don't list lose sales to dealers who did.
3. **Cost far less than eBay:** 1% versus 13.25%.
4. **List once, sell everywhere.** Imports and sync with eBay, Shopify, Card Dealer Pro and TCGplayer, partner feeds (AuctionWire), and AI assistants bring buyers we don't have to find ourselves.
5. **Agents that make trading faster.** Buyer and repacker agents find and offer on cards around the clock; dealer agents price and respond to offers within the dealer's rules. Offers settle in minutes, not days.
6. **Trust built in.** Every graded card is checked against GTCR and registered automatically, every lot comes with a cert list, every sale is traceable to a known dealer, and funds are held until the card ships or is picked up. That matters to repackers facing scrutiny over sourcing.
7. **Every sale strengthens the data.** Each sale through CardShow records a verified price, building show-floor price data no online tool has.

## What makes this hard to copy

- **A live map of show and shop inventory** (what's for sale, where and when) that grows with every dealer and show.
- **A network of wholesale demand** with buy orders tied to that inventory.
- **Agents that can act on physical, local inventory,** which online-only marketplaces can't offer.
- **Verified sale prices** from every sale through CardShow.
- **Neutral positioning:** CardShow supplies other platforms rather than competing with them, which makes it a natural partner, and a natural acquisition target for companies like Arena Club.

## How to describe it

> "CardShow is the first card marketplace where AI agents can shop the show floor. Collectors and repackers send an agent to find, hold and buy cards from dealers' tables, and dealers' agents price and negotiate within their rules, so cards sell faster at a fraction of eBay's fees."

## What success looks like (first 90 days after launch)

| Measure | Target |
|---|---|
| Dealers with active listings | 25+ |
| Active listings | 3,000+ |
| Approved wholesale buyers | 10+ |
| Wholesale buyers who buy more than once | 5+ |
| Lots sold | 20+ |
| Offers per 100 listings per month | 5+ |
| Accepted sales actually completed | 90%+ |
| Sales where the card had already sold elsewhere | Under 3% |
| Offers placed by agents that dealers accept | 30%+ |
| Gross sales through CardShow | $25,000+ per month by day 90 |

---

# Part 2: Build plan

## Sequence and rough timing

| Phase | What | Rough time* | Depends on |
|---|---|---|---|
| 0 | Foundations: legal, security fixes, listing data model | 1–2 weeks | InfernoRed review |
| 1 | Public search, listing pages, saved searches, **read-only MCP server** | 2–3 weeks | Phase 0 |
| 2 | Buy Now, Make an Offer, local pickup, **dealer offer rules** | 2–3 weeks | Phase 1 |
| 3 | **Wholesale:** accounts, Show Drops, lots, buy orders, Last Hour Lots, **repacker sourcing agent v1** | 3 weeks | Phase 2 |
| — | **Pilot** with 10–20 dealers, one card shop and 5–10 wholesale buyers, paying through Stripe payment links | 3–4 weeks | Phases 1–3 |
| 4 | Checkout through Stripe Connect | 3–4 weeks | Pilot results, LLC, Stripe approval |
| 5 | eBay and Shopify sync | 3–4 weeks | Phase 2 |
| 6 | **Agents:** buyer card-hunting agent, dealer agent, then **ACP checkout** for outside AI assistants | 3–4 weeks | Phase 4 |
| 7 | **DO NOT BUILD YET:** partner feed API at scale, agent-to-agent negotiation, agents buying without approval, data products | — | Pilot and Phase 6 results |

\*Rough estimates for part-time building with Claude Code. Adjust after the InfernoRed review.

**Why this order:** search, offers and wholesale let us run a real pilot with manual payment links before building Stripe Connect. Agents that act for people come only after payments and inventory accuracy are proven. An agent acting on unreliable inventory would make things worse, not better.

## Ground rules (every phase)

1. **One inventory record per card.** Every channel (CardShow, eBay, Shopify, the table, partners, agents) reads and writes the same status. Never copy inventory into a second table.
2. **A card can only be sold once.** Every status change from `active` to `reserved` or `sold` happens inside a single Postgres function that locks the row. No client code or agent changes status directly.
3. **Money is stored in integer cents.**
4. **CardShow never stores card numbers or bank details.** Stripe holds all payment data.
5. **Security comes first.** Every new table has row-level security.
6. **Every webhook is verified and processed only once,** with signature checks and stored event IDs.
7. **Every phase is behind a feature flag.**
8. **Mobile first.**
9. **Use `var(--accent)` for gold,** never `var(--gold)`.
10. **Reuse what exists:** card identification, comps (Card Hedge, PriceCharting), GTCR checks and registration, show pages, and the CSV, Shopify, Card Dealer Pro and TCGplayer imports.
11. **Two front ends, one back end.** The buyer site and the dealer app both read and write through the same Supabase tables and Postgres functions. The buyer site never gets its own copy of inventory, and never uses the Supabase service key in the browser.

### Agent rules (apply to every agent feature)

12. **Every agent acts for a verified CardShow account,** under a written set of limits (a "mandate") that the person approves: what it can do, spending limits, price limits, and whether it needs approval.
13. **Agents use the same functions as people.** No special paths around reservations, offers or dealer confirmation.
14. **The dealer still confirms every order,** including orders placed by agents.
15. **Every agent action is logged** in `agent_actions` and visible to the person it acts for.
16. **Limits on outside agents:** rate limits per account and per IP, a maximum number of reservations per buyer, a maximum purchases per dealer per day, and Stripe Radar on every payment.
17. **People can pause or revoke any agent at any time,** and the change takes effect immediately.

---

## Phase 0: Foundations

### Outside the code (Stephen)

- [ ] **Form the LLC** and open a business bank account.
- [ ] **Apply for Stripe Connect** as a marketplace platform.
- [ ] **Have a lawyer review:** marketplace terms, buyer and seller rules, wholesale terms, the returns and claims policy (Phase 2 and 3), the dealer standing policy, the agent liability position below, and confirmation that the payment setup doesn't require a money transmitter license.
- [ ] **Ask an accountant:** whether CardShow must collect California sales tax from day one (it's based in California), which other states to watch first, and how resale certificates should be handled for wholesale buyers.
- [ ] **Turn on Stripe Tax** for the Connect platform once Stripe approves the account, and install the **Exemptax** Stripe app for resale certificates.

### Agent liability (starting position for the lawyer)

- **The user is responsible** for actions their agent takes within the limits they approved, like an authorized card purchase.
- **CardShow is responsible** if its system lets an agent act beyond those limits.
- **Safeguards that limit harm either way:** dealer confirmation on every order, and a 1-hour cancellation window on any purchase placed by an agent.
- [ ] **Fix the critical security findings** from the InfernoRed review before any buyer-facing feature launches.

### Listing data model

Extend the existing `inventory` table:

```sql
alter table inventory
  add column listing_status text not null default 'draft',
    -- 'draft' | 'active' | 'reserved' | 'sold' | 'delisted'
  add column price_cents integer,
  add column comp_value_cents integer,          -- latest comp, refreshed daily
  add column min_offer_cents integer,
  add column auto_accept_cents integer,
  add column accepts_offers boolean default true,
  add column wholesale_eligible boolean default true,
  add column sale_modes text[] default '{ship}', -- {'ship','local_pickup'}
  add column shipping_options jsonb,
  add column location_type text,                 -- 'show' | 'shop' | 'none'
  add column show_id uuid references shows(id),
  add column shop_id uuid,
  add column table_label text,
  add column early_access_until timestamptz,
  add column lot_id uuid,                        -- set when the card is in a lot
  add column availability_confirmed_at timestamptz,
  add column reserved_until timestamptz,
  add column sold_at timestamptz,
  add column sold_channel text;                  -- 'cardshow' | 'ebay' | 'shopify' | 'in_person' | 'partner' | 'agent'
```

### Status functions

`reserve_listing(listing_id, buyer_id, reason, hold_minutes, actor)` locks the row, succeeds only if the card is `active`, and records who acted (`actor` = person or agent ID). It also checks a reservation cap per buyer. `reserve_listings(listing_ids[], ...)` reserves several cards at once, or none if any card is unavailable; lots and bundles use it.

Also `release_listing`, `mark_sold` and `delist`. A scheduled function returns expired reservations to `active` every 5 minutes.

### Acceptance criteria

- [ ] Two simultaneous reservations of the same card: exactly one succeeds.
- [ ] `reserve_listings` on a set where one card is sold reserves none of them.
- [ ] No client code can update `listing_status` directly.
- [ ] Existing features still work.

---

## Phase 1: Search, listing pages and the read-only MCP server

### The buyer site (separate from the dealer app)

- **A new site** (for example `getcardshow.com` for buyers, with the dealer app at `app.getcardshow.com` or its current path), built on the server with Astro or Next.js and deployed on Netlify. Confirm the framework with InfernoRed.
- **Pages are built on the server** so listings load fast on phones, appear in Google, show proper link previews, and are easy for AI assistants to read.
- **It reads public data** through Supabase with the public key and row-level security. Buying actions (holds, offers, checkout) call the same Postgres functions the dealer app uses, through Netlify Functions.
- **Shared sign-in:** buyers and dealers use the same Supabase Auth accounts, so a dealer can also buy.
- **Keep the brand consistent:** the same tokens (gold `#F5C842` as `var(--accent)`, black `#07080C`, surface `#0D1018`, card `#131828`, border `#1E2640`) and fonts.

### Search

- **Open to anyone;** buying requires an account.
- **Postgres full-text search plus `pg_trgm`** for typos.
- **Filters:** category, player or character, year, set, number, parallel, grader, grade, price, **comp value range**, how to buy, and **location** ("within X miles, this weekend").
- **Sort:** best match, price, price as a percentage of comps, newest, distance.

### Listing pages and dealer storefronts

- Public listing pages at `getcardshow.com/c/{id}-{slug}`, generated on the server, with photos, details, grade and cert number, a **"GTCR checked"** badge, price, comps, dealer rating, and location.
- Dealer storefronts at `getcardshow.com/d/{dealer}`.
- **Structured product data** (schema.org Product and Offer markup) on every listing page, so AI assistants and search engines can read it.

### Saved searches and alerts

Save a search, and get an email through Loops when new listings match, at most one per hour.

### Read-only MCP server (agent discovery)

**File:** `netlify/functions/mcp.js` (an MCP server over HTTP)

**Tools to expose (read-only):**

| Tool | What it does |
|---|---|
| `search_cards` | Searches active public listings, with the same filters as the website |
| `get_listing` | Returns a listing's details, price, comps, GTCR status, location and availability |
| `list_upcoming_shows` | Returns shows near a location, with dates and the number of listed cards |
| `get_show_inventory` | Searches listings at a specific show |

**Rules:**
- **Public data only.** It never returns early-access listings or anything about buyers, and never personal data about dealers beyond their public storefront.
- **Every result links to the listing page,** with a referral tag (`?ref=agent-{client}`), so purchases happen on CardShow.
- **Rate limits per client;** log every call in `agent_actions` with `actor_type = 'external_agent'`.
- **No buying, holding or offers** in this phase.

### Acceptance criteria

- [ ] A search for "Charizard PSA 10" returns results in under 1 second with 10,000 listings.
- [ ] "Within 25 miles, this weekend" returns only listings at nearby shows or shops on those dates.
- [ ] Early-access listings stay hidden from public search and the MCP server until their public time.
- [ ] An MCP client (for example Claude) can search CardShow and get correct listings with links.
- [ ] Listing pages pass a structured data validator.

---

## Phase 2: Buy Now, Make an Offer, local pickup and dealer offer rules

### How purchases work

- **Buy Now:** reserve for 15 minutes, the dealer confirms the card is available (2 hours normally, 15 minutes during a live show), then the buyer pays.
- **Make an Offer:** offers expire in 24 hours (2 hours during a live show); the dealer accepts, declines or counters; one counter from the buyer.
- **Hold for local pickup:** the full amount is held on the buyer's card and charged when the dealer scans the buyer's pickup QR at the table (details below).
- **Multi-card offers** on several cards from one dealer, accepted or declined together.

### Local pickup holds

Modeled on eBay's local pickup (pay at checkout, pickup code scanned at handoff), using a card hold instead of an immediate charge where possible.

| Situation | What happens |
|---|---|
| **Show or pickup within 7 days** | Place a **hold for the full amount** on the buyer's card (Stripe manual capture). The buyer isn't charged yet. |
| **Show or pickup more than 7 days away** | **Charge the full amount up front** (standard Stripe card holds expire after 7 days). |
| **Buyer picks up** | The dealer scans the pickup QR; CardShow charges the held amount (or, if already charged, marks the order picked up) and the dealer is paid. |
| **Buyer doesn't show by the end of the show** | Charge the dealer's **no-show fee** (dealer sets 0–20%, default 10%) and release the rest of the hold, or refund the rest if already charged. |
| **Dealer can't produce the card** | Release the hold or refund in full; counts against the dealer's standing. |

**During the pilot** (before Stripe Connect), collect full payment through a payment link and refund manually by the same rules.

### Returns and claims (retail orders)

Modeled on eBay's Money Back Guarantee.

| Reason | Who pays return shipping | Buyer gets |
|---|---|---|
| **Not as described:** wrong card, wrong grade or cert, damage not shown in photos, cracked slab | **Dealer** (CardShow issues the label and deducts it from the dealer's payout) | Full refund, including original shipping, when the card is returned |
| **Arrived damaged in shipping** | **Dealer** (dealer should insure shipments) | Full refund when returned, or a partial refund if both agree |
| **Changed mind** | **Buyer**, only if the dealer's policy accepts returns | Item price only |

- **Buyers file claims within 30 days of delivery** (matching eBay), with photos. Claims about raw cards require photos of the issue.
- **The dealer responds within 3 days:** accept the return, or offer a partial refund that the buyer may accept or decline. A partial refund can't be forced on either side.
- **If they can't agree within 3 more days, CardShow decides.** When in doubt on a not-as-described claim with photo evidence, side with the buyer, as eBay does.
- **Each dealer sets a return policy** for change-of-mind returns: none (default, common for cards), or 14 or 30 days.

### Dealer offer rules (the base of the dealer agent)

Dealers set rules once for all their listings, and can override them on any listing:

| Rule | Example |
|---|---|
| Decline offers below | 80% of asking price, or 75% of comps |
| Accept offers at or above | 95% of asking price |
| Counter offers in between | Counter at 90% of asking price |
| Wholesale minimum | No wholesale offers below 75% of comps |
| Respond during shows | Only accept automatically when I'm not at a show (so I can check the card) |

All rules run inside the offers function. Every automatic decision is logged and shown to the dealer ("Accepted automatically: offer was 96% of asking").

### New tables

```sql
create table offers (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null,
  dealer_id uuid not null,
  listing_ids uuid[],
  lot_id uuid,                          -- set when the offer is on a lot
  amount_cents integer not null,
  message text,
  status text not null default 'pending', -- 'pending' | 'accepted' | 'declined' | 'countered' | 'expired' | 'withdrawn'
  counter_amount_cents integer,
  decided_by text,                      -- 'dealer' | 'dealer_rule' | 'dealer_agent'
  placed_by text default 'buyer',       -- 'buyer' | 'buy_order' | 'buyer_agent' | 'external_agent'
  expires_at timestamptz not null,
  responded_at timestamptz,
  created_at timestamptz default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null,
  dealer_id uuid not null,
  listing_ids uuid[] not null,
  lot_id uuid,
  offer_id uuid references offers(id),
  order_type text not null default 'retail', -- 'retail' | 'wholesale'
  fulfillment text not null,            -- 'ship' | 'local_pickup'
  ship_to jsonb,                        -- address, including vault addresses
  subtotal_cents integer not null,
  shipping_cents integer default 0,
  buyer_fee_cents integer default 0,
  seller_fee_cents integer default 0,
  status text not null,
  confirm_by timestamptz,
  pay_by timestamptz,
  tracking_number text,
  carrier text,
  pickup_code text,
  payment_link_url text,                -- pilot only
  stripe_payment_intent_id text,        -- Phase 4
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### More new tables

```sql
create table dealer_policies (
  dealer_id uuid primary key,
  accepts_change_of_mind_returns boolean default false,
  return_window_days integer,           -- 14 or 30 when returns are accepted
  no_show_fee_pct numeric default 10,   -- 0 to 20
  wholesale_min_pct_of_comp numeric,
  updated_at timestamptz default now()
);

create table claims (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) not null,
  listing_ids uuid[] not null,          -- the specific cards affected (one card in a lot)
  reason text not null,                 -- 'not_as_described' | 'damaged_in_shipping' | 'not_received' | 'change_of_mind'
  description text,
  photo_paths text[],
  requested text not null,              -- 'return_full_refund' | 'partial_refund'
  dealer_response text,                 -- 'accept_return' | 'offer_partial' | 'decline'
  partial_offer_cents integer,
  buyer_accepted_partial boolean,
  status text not null default 'open',  -- 'open' | 'awaiting_return' | 'resolved_partial' | 'resolved_refund' | 'escalated' | 'closed_no_action'
  return_label_cost_cents integer,      -- charged to the dealer
  resolved_by text,                     -- 'agreement' | 'cardshow'
  dealer_respond_by timestamptz,
  created_at timestamptz default now(),
  resolved_at timestamptz
);

create table dealer_standing (
  dealer_id uuid primary key,
  missed_confirmations_30d integer default 0,
  confirmation_rate_30d numeric,
  sold_elsewhere_while_listed_30d integer default 0,
  claims_against_30d integer default 0,
  status text not null default 'good',  -- 'good' | 'warned' | 'follow_up' | 'suspended' | 'banned'
  search_rank_penalty numeric default 0,
  suspended_until timestamptz,
  notes text,
  updated_at timestamptz default now()
);
```

### Dealer standing

A nightly job recalculates `dealer_standing` from the last 30 days of orders, listings and claims.

| Step | Trigger (last 30 days) | What happens |
|---|---|---|
| **Warning** | 2 orders not confirmed in time, or 1 card sold elsewhere while still listed | Automatic in-app and email warning with the dealer's numbers |
| **Direct follow-up** | 4 missed confirmations, confirmation rate below 90%, or 2 cards sold elsewhere | Admin task to contact the dealer; listings shown lower in search until numbers improve |
| **Suspension** | Problems continue for 14 days after follow-up | Listings hidden for 14–30 days; open orders must still be completed |
| **Ban** | Repeated suspensions, or any fraud (a fake listing or misrepresented grade) | Account removed; admin decision only, logged with reason |

**Dealers see their own scorecard:** confirmation rate, average response time, cards sold elsewhere while listed, and open claims.

### Dealer screens, notifications and pilot payment

Same as v1: a mobile Orders and Offers inbox, offer rules, price help from comps, tracking entry, the pickup QR scanner, response-time display, email notifications through Loops, and Stripe payment links during the pilot.

### Acceptance criteria

- [ ] Buy Now reserves the card; a second buyer sees "Reserved."
- [ ] Unconfirmed orders are released on time, and the buyer isn't charged.
- [ ] Each dealer rule produces the correct result, and every automatic decision is logged and shown to the dealer.
- [ ] Multi-card offers reserve all cards or none.
- [ ] A pickup QR scan marks the order picked up and the cards sold.
- [ ] A no-show charges only the dealer's no-show fee and releases the rest.
- [ ] A not-as-described claim creates a return label charged to the dealer, and the buyer is refunded in full when the return is delivered.
- [ ] A partial refund only completes when the buyer accepts it.
- [ ] Dealer standing moves through each step at the right triggers, and dealers can see their own scorecard.

---

## Phase 3: Wholesale for repackers, breakers and rip platforms

### Wholesale accounts

- **Application:** business name, website and social links, buyer type (repacker, breaker, rip platform, card shop), categories, monthly volume, typical comp range, delivery locations (address, vault, or pickup at shows), resale certificate, and CTCA membership, Certified Breaker or RP-1 status, or PSA repack certification if any.
- **An admin approves each account.** Approved buyers get a "Verified Wholesale" badge.
- **Resale certificates:** buyers who want tax-exempt purchases submit a resale certificate through Exemptax **before** their first tax-exempt purchase. Until a valid certificate is on file, sales tax is collected as normal.
- **Fees:** wholesale buyers pay **card processing only**, with **ACH (bank transfer) encouraged** to keep costs low on large lots. A subscription comes once there are enough buyers and sellers; tell early buyers now and offer them a discount.

### Show Drops (early access)

- 48 hours before a show, participating dealers' show inventory is visible only to wholesale buyers; it becomes public 24 hours before.
- Dealers choose per show whether to take part.
- Wholesale buyers get a Show Drop email with the count of cards and dealers.

### Lots

Dealers build lots from their inventory: *"40 PSA 9–10 football slabs, comps $40–$80 each."* **Minimum lot size: 5 cards** (a setting, adjusted after repacker interviews).

- **Lot builder:** pick cards by filter (category, grader, grade, comp range), or have CardShow suggest a lot from the dealer's slow-moving inventory.
- **Every lot shows:** card count, total comp value, the asking price as a percentage of comps, and a **cert list** (each card's grader, grade and cert number, with GTCR status). The cert list can be downloaded as a CSV.
- **Buyers make one offer on the whole lot;** the dealer accepts with one tap. On acceptance, `reserve_listings` reserves every card in the lot, or none.
- **Cards in a lot can't be sold separately** while the lot is listed. Removing a card updates the lot.

**Each card in a lot carries its share of the lot price,** based on its share of the lot's total comp value. This is used for partial refunds and for tax.

```sql
create table lots (
  id uuid primary key default gen_random_uuid(),
  dealer_id uuid not null,
  title text not null,
  listing_ids uuid[] not null,
  card_count integer not null,
  total_comp_cents integer not null,
  ask_cents integer not null,
  status text not null default 'active', -- 'draft' | 'active' | 'reserved' | 'sold' | 'withdrawn'
  last_hour boolean default false,
  show_id uuid references shows(id),
  created_at timestamptz default now()
);
```

### Buy orders by value tier

Wholesale buyers save buy orders describing what they want, not specific cards:

| Field | Example |
|---|---|
| Categories | Football, basketball |
| Graders and grades | PSA 9–10, BGS 9.5 |
| Comp value range | $25–$150 per card |
| Maximum price as % of comps | 82% |
| Optional player or set list | Rookies only |
| Monthly quantity and budget | Up to 60 cards, $5,000 |
| Delivery | Ship to PSA vault address, or pick up at shows |

```sql
create table buy_orders (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null,
  criteria jsonb not null,
  max_pct_of_comp numeric not null,
  monthly_qty integer,
  monthly_budget_cents integer,
  spent_this_month_cents integer default 0,
  delivery jsonb,
  mode text not null default 'suggest',  -- 'suggest' | 'auto_offer'
  active boolean default true,
  created_at timestamptz default now()
);
```

### Repacker sourcing agent v1

This uses buy orders, without AI deciding anything yet.

- **When a new listing or lot matches a buy order,** the agent prepares an offer at the buy order's price.
- **In `suggest` mode** (the default), the buyer gets a daily digest of suggested offers and approves them in one tap or in bulk.
- **In `auto_offer` mode,** the agent sends offers automatically within the buy order's budget and limits. Turn this on for pilot buyers only.
- **It groups matching cards from the same dealer into one multi-card offer.**
- **Every action is logged** in `agent_actions`, and buyers see a monthly summary: cards bought, average percentage of comps paid, and budget left.

### Last Hour Lots

- In the final hour of a show, dealers can mark lots or cards as **Last Hour** at a lower price.
- Wholesale buyers and repackers at or near the show get an alert right away.
- Pickup at the table before the show closes, or shipped afterward.

### Wholesale dealer controls

- **A wholesale minimum:** the lowest percentage of comps a dealer will accept from wholesale buyers.
- **Choose which cards are wholesale-eligible** (default: all).
- **Choose per show** whether to take part in Show Drops and Last Hour Lots.

### Delivery

- Ship to any address the buyer specifies, **including vault intake addresses** (PSA vault, or a rip platform's own facility). Save these addresses on the wholesale account.
- **Pickup at the show** for local buyers.
- **Insured, tracked shipping is required** for wholesale lots.

### Wholesale claims and lot disputes

Modeled on eBay, using the cert list to handle each card separately.

1. **The buyer files a claim within 7 days of delivery,** naming each affected card by cert number, with photos.
2. **The dealer chooses within 3 days:**
   - **a partial refund** for the affected cards, at their share of the lot price; or
   - **a return of the whole lot** with a full refund, return shipping paid by the dealer.
3. **The buyer accepts the partial refund or asks for the full return.** Neither side can be forced into a partial refund.
4. **CardShow decides** if they can't agree within 3 more days.
5. **Wholesale payouts are released 7 days after delivery,** once the claim window closes, so refunds can be paid from the order.

### Acceptance criteria

- [ ] Only approved wholesale buyers see early-access listings and Show Drops.
- [ ] A lot shows the correct total comp value and percentage, and its cert list matches its cards.
- [ ] Accepting a lot offer reserves every card in it, or none.
- [ ] A buy order matches new listings correctly and never exceeds its budget or percentage-of-comps limit.
- [ ] In `suggest` mode, nothing is sent until the buyer approves.
- [ ] Last Hour alerts reach nearby wholesale buyers within 2 minutes.
- [ ] Every agent action appears in the buyer's activity log.
- [ ] Lots under the minimum size can't be published.
- [ ] Tax-exempt pricing only applies when a valid resale certificate is on file.
- [ ] A claim on one card in a lot calculates its partial refund from that card's share of the lot price.
- [ ] Wholesale payouts wait until the 7-day claim window closes.

---

## Pilot (between Phase 3 and Phase 4)

- **Dealers:** 10–20 across two or three SoCal shows, plus one card shop (for example Burbank Sports Cards).
- **Wholesale buyers:** 5–10 repackers, breakers or rip platforms. Ask Nick Jarman (CTCA), Scott Baldwin (CardsHQ repacks) and PSA for introductions.
- **Partner channel:** AuctionWire, sending buyers to CardShow listing pages.
- **Payments:** Stripe payment links.
- **What to measure:**
  - offers per 100 listings;
  - dealer response time;
  - accepted sales actually completed;
  - how often a card had already sold elsewhere;
  - lots sold;
  - average percentage of comps paid on wholesale;
  - wholesale buyers who buy more than once;
  - suggested offers buyers approve;
  - agent offers dealers accept;
  - dealer feedback.
- **Decision to build Phase 4:** 70%+ of accepted sales completed, at least 3 wholesale buyers who buy more than once, and dealers who say they'd list most of their inventory.

---

## Phase 4: Checkout through Stripe Connect

Same as v1, with these additions:

- **Dealer accounts:** Stripe Connect Express. **Funds move by separate charges and transfers,** so CardShow holds the money until the card is delivered or picked up.
- **Fees are set by order type** (stored as configuration):

| Fee | Retail | Wholesale |
|---|---|---|
| Seller fee | 1% | 1% |
| Buyer fee | 1% plus card processing | Card processing only (ACH encouraged); subscription later |
| Shipping | Paid by buyer | Paid by buyer; vault shipping at the buyer's chosen service |

- **Wholesale buyers can pay by ACH,** which costs much less than cards on large lots.
- **Local pickup uses manual capture:** hold the card at reservation, capture at the QR scan, partially capture the no-show fee if the buyer doesn't come. Use up-front charges for pickups more than 7 days out.
- **Payout timing:**

| Order type | Dealer is paid |
|---|---|
| Retail, shipped | After delivery is confirmed (tracking or buyer), or 7 days after shipping if neither |
| Retail, local pickup | After the pickup QR scan |
| Wholesale | 7 days after delivery, once the claim window closes |

- **Refunds and claims:** partial refunds, full refunds, and return-label costs charged to the dealer all run through Stripe and are recorded in the ledger. If the dealer has already been paid, reverse the transfer first.

### Sales tax (Stripe Tax for marketplaces)

- **Turn on Stripe Tax for the Connect platform,** so CardShow calculates and collects sales tax on orders where it's required as the marketplace facilitator.
- **Start collecting in each state as you register,** following accountant guidance. California may be required from day one; most other states only once CardShow's sales into them pass their threshold (about $100,000 in most states; $500,000 in California, New York and Texas).
- **Use Stripe Tax's threshold monitoring** to see which states are approaching.
- **Tax-exempt wholesale sales:** mark the buyer tax-exempt in Stripe only while Exemptax shows a valid resale certificate. Exemptax handles expiration and renewals.
- **Dealers** don't collect sales tax themselves on CardShow sales (except in Hawaii; confirm with the accountant).

```sql
create table tax_exemptions (
  buyer_id uuid primary key,
  exemptax_customer_id text,
  states text[],                        -- states the certificate covers
  valid boolean default false,
  expires_at date,
  updated_at timestamptz default now()
);
```
- **Webhooks, ledger, refunds, disputes and the daily ledger check** are the same as v1.
- **Get ready for agent payments.** Keep checkout in Stripe's standard building blocks (PaymentIntents), so ACP checkout can be added in Phase 6 without rebuilding it.

### Acceptance criteria

Same as v1, plus:
- [ ] A wholesale lot order paid by ACH completes and transfers correctly.
- [ ] Wholesale and retail fees are applied correctly.
- [ ] A local pickup hold is captured on QR scan, and a no-show captures only the no-show fee.
- [ ] Sales tax is calculated by Stripe Tax for a test address in a registered state, and not charged to a buyer with a valid resale certificate.
- [ ] Refunds after payout reverse the dealer transfer correctly.

---

## Phase 5: eBay and Shopify sync

Same as v1:
- Dealers connect eBay and Shopify; tokens are stored encrypted.
- Check for eBay orders every 2–3 minutes; when a CardShow sale happens, set eBay quantity to 0.
- Use Shopify webhooks for orders and inventory, and set Shopify inventory to 0 when a CardShow sale happens.
- The first sale wins; the other order is canceled and refunded; the double-sell rate is tracked for each dealer.

**Added:** when a card in a lot sells on another channel, remove it from the lot and notify the dealer and any buyer with a pending offer on that lot.

---

## Phase 6: Agents

### 6a. Buyer card-hunting agent

A buyer describes what they want in plain language: *"Find me a PSA 10 Jayden Daniels Prizm Silver under $300, pickup within 30 miles, or shipped if it's at least 15% under eBay."*

- **Claude (Anthropic API)** turns the request into a structured mandate (cards, grades, price limits, location, delivery) and shows it to the buyer to confirm.
- **The agent watches** new listings, Show Drops and price drops, and runs saved searches continuously.
- **What it can do depends on the mandate:**
  - **Notify only;**
  - **Hold or offer with approval** (the default): a one-tap approval request by email or in the app;
  - **Offer automatically** within strict limits (an amount per card, a monthly budget).
- **Buying always goes through normal checkout,** with dealer confirmation.

### 6b. Dealer agent

Built on the Phase 2 offer rules, adding:
- **Pricing:** suggests prices from comps and recent CardShow sales; with the dealer's permission, lowers prices on cards that haven't sold within set limits.
- **Offers:** handles offers within the dealer's rules, and writes a short note explaining each counter.
- **Inventory hygiene:** flags listings that may be out of date, asks the dealer to confirm them before a show, and catches cards listed both on CardShow and elsewhere.
- **Show prep:** *"34 buyers are watching cards you own, and 3 wholesale buyers want PSA 9 rookies under $100. Bring these 60 cards to Saturday's show."*
- **Lot suggestions:** suggests lots from slow-moving inventory that match active buy orders.

### 6c. Outside AI assistants: holds, offers and ACP checkout

- **Extend the MCP server** with `hold_card`, `make_offer` and `start_checkout`. Each requires the buyer to sign in to CardShow once and approve a mandate for that assistant.
- **Add ACP checkout through Stripe** so an assistant can complete a purchase with a payment token scoped to CardShow and the order total. The order still goes through dealer confirmation and normal order handling.
- **Add an agent-readable product feed** alongside the AuctionWire feed.

### Tables for all agents

```sql
create table agent_mandates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,               -- the buyer or dealer the agent acts for
  agent_type text not null,             -- 'buyer_hunt' | 'repacker_sourcing' | 'dealer' | 'external_assistant'
  client_name text,                     -- for outside assistants
  scope jsonb not null,                 -- allowed actions and criteria
  per_item_limit_cents integer,
  monthly_budget_cents integer,
  requires_approval boolean default true,
  active boolean default true,
  revoked_at timestamptz,
  created_at timestamptz default now()
);

create table agent_actions (
  id uuid primary key default gen_random_uuid(),
  mandate_id uuid references agent_mandates(id),
  actor_type text not null,             -- 'buyer_agent' | 'dealer_agent' | 'repacker_agent' | 'external_agent'
  action text not null,                 -- 'search' | 'suggest_offer' | 'offer' | 'counter' | 'hold' | 'checkout' | 'reprice' | 'decline'
  target_ids uuid[],
  amount_cents integer,
  reason text,                          -- plain-language explanation shown to the person
  approved_by_owner boolean,
  created_at timestamptz default now()
);
```

### Acceptance criteria

- [ ] A buyer's plain-language request becomes a mandate the buyer confirms before anything runs.
- [ ] No agent action ever exceeds its mandate's limits; tests prove that attempts to do so are refused.
- [ ] Revoking a mandate stops the agent immediately.
- [ ] Every agent action is visible to its owner, with a plain-language reason.
- [ ] An outside assistant can search, hold and (with approval) complete checkout, and the dealer still confirms the order.
- [ ] Rate limits and per-buyer caps block an agent that tries to hold a dealer's whole inventory.

---

## Phase 7: Later (DO NOT BUILD YET)

- Partner feed API at scale (AuctionWire and other aggregators).
- Buyer and dealer agents negotiating directly with each other within both owners' limits.
- Agents buying without approval beyond small limits.
- Paid wholesale subscriptions and dealer subscription tiers.
- Show walkthrough videos linked to listings.
- Price data products from completed sales.
- SMS alerts during shows.

---

# Part 3: Business model summary

| Revenue | When | Launch price |
|---|---|---|
| Seller fee | Every completed sale | 1% |
| Buyer fee (retail) | Every completed sale | 1% plus card processing |
| Wholesale buyer fee | Launch | Card processing only (ACH encouraged) |
| Wholesale access | Once there are enough buyers and sellers | Subscription, priced from pilot results |
| Dealer Pro (including the dealer agent) | After Phase 6 | Price help, agent, analytics, wider distribution |
| Data licensing | When volume supports it | Verified show and shop sale prices |

**Fee review:** 1% + 1% is a launch rate. At 3% from the seller, CardShow would still cost a quarter of eBay's fee.

**What it takes:** at an average sale of $150, every $100,000 in monthly sales earns about $2,000 a month at 1% + 1%, or about $4,000 at 3% + 1%. Wholesale lots raise the average order size, which helps.

---

## Decisions made (v3)

| Question | Decision |
|---|---|
| Deposit or full payment for local pickup? | Hold the full amount on the card, charge at pickup; no-show fee set by the dealer (default 10%); charge up front if pickup is more than 7 days out |
| Who pays return shipping? | Follow eBay: dealer pays when not as described; buyer pays for change-of-mind returns where the dealer accepts them |
| Wholesale buyer fee | Card processing only until there are enough buyers and sellers, then a subscription |
| Lot disputes | Per-card claims using the cert list; partial refund or full lot return; neither side forced into a partial refund |
| Dealers who don't confirm or keep inventory current | Warning, direct follow-up, suspension, ban, with set triggers |
| Sales tax | Stripe Tax for marketplaces, plus Exemptax for resale certificates; accountant confirms California and early states |
| Buyer marketplace architecture | Separate buyer site sharing the same Supabase back end; dealer app stays in `app.html` |

## Still open

1. **Minimum lot size:** default 5 cards; confirm in repacker interviews.
2. **Agent liability:** lawyer to review the starting position in Phase 0.
3. **No-show fee range:** confirm 0–20% with pilot dealers.
4. **Framework for the buyer site** (Astro or Next.js): confirm with InfernoRed.

## Repacker interview questions (for the pilot)

1. Which value ranges do you struggle most to keep stocked, and how many cards a month?
2. What percentage of comps do you typically pay, and how do you set comps?
3. Lots or single cards? What's the smallest lot worth your time?
4. Which graders and grades do you accept?
5. Where do cards need to go: your address, a vault, or pickup at a show?
6. What documentation do you need for sourcing transparency?
7. Would you let an agent send offers for you within a budget?

## Update `CLAUDE.md` after each phase

New tables, functions, webhooks, feature flags, environment variables, the rule that only status functions may change a listing's status, and the agent rules above.
