-- CardShow Marketplace — Buy Now and orders (Phase 2). Run after 20261211120000_marketplace_offer_rules.sql.
-- Re-runnable.
--
-- Pilot model (Stephen, 2026-11-24): no money on CardShow. The buyer pays the dealer through the dealer's own
-- payment links (Venmo, PayPal, Cash App, Zelle, a link) or at the table; the dealer marks the order paid.
-- No fees yet: buyer_fee_cents / seller_fee_cents stay 0 and fee_status 'not_billed', so completed orders'
-- prices can be billed later.
--
-- Flow (plan v3, "How purchases work"):
--   Buy Now → order awaiting_confirmation, the card reserved for the buyer; the dealer confirms they still have
--   it within 2 hours (15 minutes while they're at a show) → awaiting_payment (the buyer sees the dealer's
--   payment links; 24 hours to pay, or until the pickup show ends) → the dealer marks it paid (the card is sold)
--   → shipped with tracking → completed (the buyer says they got it, or 14 days after shipping). A pickup order
--   is completed when the dealer marks it paid and picked up.
-- * A buyer's own hold or accepted offer (listing_reservations reason hold / offer_accepted) becomes an order
--   at the agreed price (order_from_hold); Buy Now on a card the buyer holds does that too.
-- * The order's reservation (reason buy_now) runs a day past the order's deadlines, so expire_orders(), run
--   before expire_listing_reservations() by the 5-minute job, always ends the order first.
-- * A card sold at the table while ordered breaks the reservation (sync trigger); expire_orders() then cancels
--   the order ('sold_elsewhere') and emails the buyer. Missed confirmations and sold-elsewhere orders are what
--   dealer standing will count (not built yet).

begin;

-- ── How a dealer gets paid ────────────────────────────────────────────────────
create table if not exists public.dealer_payment_methods (
  dealer_id uuid primary key references auth.users(id) on delete cascade,
  methods jsonb not null default '[]'::jsonb,   -- [{kind: venmo|paypal|cashapp|zelle|link|other, value}]
  note text,
  updated_at timestamptz not null default now()
);
alter table public.dealer_payment_methods enable row level security;
drop policy if exists dealer_payment_methods_read_own on public.dealer_payment_methods;
create policy dealer_payment_methods_read_own on public.dealer_payment_methods for select to authenticated
  using (dealer_id = auth.uid());
revoke all on public.dealer_payment_methods from anon, authenticated;
grant select on public.dealer_payment_methods to authenticated;

-- ── Orders ────────────────────────────────────────────────────────────────────
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references auth.users(id),
  dealer_id uuid not null,
  listing_ids uuid[] not null check (cardinality(listing_ids) between 1 and 20),
  order_type text not null default 'retail' check (order_type in ('retail','wholesale')),
  fulfillment text not null check (fulfillment in ('ship','local_pickup')),
  ship_to jsonb,
  pickup_show_id text,
  subtotal_cents integer not null check (subtotal_cents > 0),
  shipping_cents integer check (shipping_cents is null or shipping_cents between 0 and 100000),
  buyer_fee_cents integer not null default 0,
  seller_fee_cents integer not null default 0,
  fee_status text not null default 'not_billed' check (fee_status in ('not_billed','none','billed')),
  status text not null default 'awaiting_confirmation'
    check (status in ('awaiting_confirmation','awaiting_payment','paid','shipped','completed','cancelled','expired')),
  end_reason text,
  buyer_name text, buyer_contact text, buyer_note text,
  payment_method text,
  confirm_by timestamptz not null,
  pay_by timestamptz,
  confirmed_at timestamptz, paid_at timestamptz, shipped_at timestamptz, completed_at timestamptz, ended_at timestamptz,
  carrier text, tracking_number text,
  pickup_code text,
  reservation_id uuid,
  offer_id uuid,
  from_reservation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_buyer_idx on public.orders (buyer_id, created_at desc);
create index if not exists orders_dealer_idx on public.orders (dealer_id, created_at desc);
create index if not exists orders_open_idx on public.orders (status) where status in ('awaiting_confirmation','awaiting_payment','shipped');
create index if not exists orders_listing_ids_idx on public.orders using gin (listing_ids);
alter table public.orders enable row level security;
drop policy if exists orders_read_parties on public.orders;
create policy orders_read_parties on public.orders for select to authenticated
  using (buyer_id = auth.uid() or dealer_id = auth.uid());
revoke all on public.orders from anon, authenticated;
grant select on public.orders to authenticated;

create table if not exists public.order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null check (kind in ('new','confirmed','cancelled','expired','paid','shipped')),
  to_whom text not null check (to_whom in ('buyer','dealer')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists order_events_due_idx on public.order_events (created_at) where sent_at is null;
alter table public.order_events enable row level security;
revoke all on public.order_events from anon, authenticated;

insert into public.marketplace_settings (key, value) values
  ('order_confirm_minutes', '120'::jsonb), ('order_confirm_show_minutes', '15'::jsonb),
  ('order_pay_minutes', '1440'::jsonb), ('order_pickup_pay_days', '3'::jsonb),
  ('order_auto_complete_days', '14'::jsonb), ('max_orders_per_day', '20'::jsonb)
on conflict (key) do nothing;

-- ── Helpers ───────────────────────────────────────────────────────────────────
create or replace function public._order_event(p_order uuid, p_kind text, p_to text) returns void
language sql security definer set search_path = public as $$
  insert into public.order_events (order_id, kind, to_whom) values (p_order, p_kind, p_to) $$;

create or replace function public._order_setting(p_key text, p_default integer) returns integer
language sql stable security definer set search_path = public as $$
  select (public._listing_setting(p_key, to_jsonb(p_default)))::text::integer $$;

-- A US shipping address: {name, line1, line2?, city, state (2 letters), postal (12345 or 12345-6789)}, or null if bad.
create or replace function public._order_ship_to(p jsonb) returns jsonb
language plpgsql immutable as $$
declare
  t jsonb;
  f text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return null; end if;
  t := jsonb_build_object(
    'name',   left(btrim(coalesce(p->>'name', '')), 80),
    'line1',  left(btrim(coalesce(p->>'line1', '')), 120),
    'line2',  nullif(left(btrim(coalesce(p->>'line2', '')), 120), ''),
    'city',   left(btrim(coalesce(p->>'city', '')), 80),
    'state',  upper(btrim(coalesce(p->>'state', ''))),
    'postal', btrim(coalesce(p->>'postal', '')));
  foreach f in array array['name','line1','city'] loop
    if length(t->>f) < 1 then return null; end if;
  end loop;
  if (t->>'state') !~ '^[A-Z]{2}$' or (t->>'postal') !~ '^[0-9]{5}(-[0-9]{4})?$' then return null; end if;
  return jsonb_strip_nulls(t);
end $$;

-- Order status as the parties should read it (an overdue order reads expired before the sweep runs).
create or replace function public._order_status(o public.orders) returns text
language sql stable as $$
  select case
    when o.status = 'awaiting_confirmation' and o.confirm_by <= now() then 'expired'
    when o.status = 'awaiting_payment' and o.pay_by <= now() then 'expired'
    else o.status end $$;

create or replace function public._order_end(p_order uuid, p_status text, p_reason text, p_cards text) returns void
language plpgsql security definer set search_path = public as $$
-- Ends an open order and frees its cards: p_cards 'active' (back on sale) or 'delisted' (dealer doesn't have them).
declare o public.orders; v_ids uuid[];
begin
  select * into o from public.orders where id = p_order for update;
  if o.status not in ('awaiting_confirmation','awaiting_payment') then return; end if;
  if o.reservation_id is not null then
    perform public._release_reservation(o.reservation_id, case when p_status = 'expired' then 'expired' else 'released' end,
                                        'order_' || p_reason, 'system', null);
    if p_cards = 'delisted' then
      perform set_config('cardshow.listing_fn', 'on', true);
      with u as (update public.inventory set listing_status = 'delisted'
                  where id = any(o.listing_ids) and listing_status = 'active' returning id)
      select array_agg(id) into v_ids from u;
      perform set_config('cardshow.listing_fn', 'off', true);
      if v_ids is not null then
        perform public._listing_log(v_ids, o.dealer_id, 'delisted', 'active', 'delisted', o.reservation_id, 'dealer',
                                    o.dealer_id::text, jsonb_build_object('reason', 'order_not_available'));
      end if;
    end if;
  end if;
  update public.orders set status = p_status, end_reason = p_reason, ended_at = now(), updated_at = now() where id = o.id;
end $$;

-- ── Dealer: how buyers pay you ────────────────────────────────────────────────
-- p_methods: [{kind, value}]. Returns { ok, methods } or { error: not_a_seller | too_many | bad_method (+ index) }.
create or replace function public.set_payment_methods(p_methods jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  m jsonb; k text; v text; i integer := 0;
  v_out jsonb := '[]'::jsonb;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  if not exists (select 1 from public.sellers where id = v_uid) then return jsonb_build_object('error', 'not_a_seller'); end if;
  if p_methods is null or jsonb_typeof(p_methods) <> 'array' then p_methods := '[]'::jsonb; end if;
  if jsonb_array_length(p_methods) > 6 then return jsonb_build_object('error', 'too_many'); end if;
  for m in select * from jsonb_array_elements(p_methods) loop
    k := lower(btrim(coalesce(m->>'kind', '')));
    v := btrim(coalesce(m->>'value', ''));
    if v = '' then i := i + 1; continue; end if;
    if k = 'venmo' then
      v := regexp_replace(regexp_replace(v, '^https?://(www\.)?venmo\.com/(u/)?', '', 'i'), '^@', '');
      if v !~ '^[A-Za-z0-9_-]{2,30}$' then return jsonb_build_object('error', 'bad_method', 'index', i, 'kind', k); end if;
    elsif k = 'paypal' then
      v := regexp_replace(regexp_replace(v, '^https?://(www\.)?paypal\.me/', '', 'i'), '/.*$', '');
      if v !~ '^[A-Za-z0-9]{2,30}$' then return jsonb_build_object('error', 'bad_method', 'index', i, 'kind', k); end if;
    elsif k = 'cashapp' then
      v := regexp_replace(regexp_replace(v, '^https?://(www\.)?cash\.app/', '', 'i'), '^\$', '');
      if v !~ '^[A-Za-z][A-Za-z0-9_-]{0,19}$' then return jsonb_build_object('error', 'bad_method', 'index', i, 'kind', k); end if;
    elsif k = 'zelle' then
      if length(v) > 80 or length(v) < 5 then return jsonb_build_object('error', 'bad_method', 'index', i, 'kind', k); end if;
    elsif k = 'link' then
      if v !~* '^https://[^\s/]+\.[^\s]{2,}$' or length(v) > 300 then return jsonb_build_object('error', 'bad_method', 'index', i, 'kind', k); end if;
    elsif k = 'other' then
      v := left(v, 120);
    else
      return jsonb_build_object('error', 'bad_method', 'index', i, 'kind', k);
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('kind', k, 'value', v));
    i := i + 1;
  end loop;
  insert into public.dealer_payment_methods (dealer_id, methods, note, updated_at)
  values (v_uid, v_out, nullif(left(btrim(coalesce(p_note, '')), 200), ''), now())
  on conflict (dealer_id) do update set methods = excluded.methods, note = excluded.note, updated_at = now();
  return jsonb_build_object('ok', true, 'methods', v_out);
end $$;

-- ── Create an order (shared) ──────────────────────────────────────────────────
create or replace function public._order_create(p_ids uuid[], p_buyer uuid, p_subtotal integer, p_fulfillment text,
                                                p_name text, p_contact text, p_note text, p_ship_to jsonb,
                                                p_offer_id uuid, p_from_reservation uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
-- The cards are already locked and checked by the caller, and free (active) now.
declare
  v_dealer uuid;
  v_ship jsonb;
  v_shipping integer;
  v_modes text[];
  v_pickup text;
  v_confirm integer;
  v_confirm_by timestamptz;
  v_res uuid;
  v_id uuid := gen_random_uuid();
begin
  select seller_id into v_dealer from public.inventory where id = p_ids[1];
  -- Every card must allow this way of getting it (no sale_modes = ship only).
  if exists (select 1 from public.inventory i where i.id = any(p_ids)
              and not (p_fulfillment = any(coalesce(i.sale_modes, array['ship']::text[])))) then
    return jsonb_build_object('error', 'fulfillment_not_offered');
  end if;
  if p_fulfillment = 'ship' then
    v_ship := public._order_ship_to(p_ship_to);
    if v_ship is null then return jsonb_build_object('error', 'bad_address'); end if;
    -- Shipping: the cards' flat prices added up when every card has one, else the dealer sets it when confirming.
    select case when bool_and((i.shipping_options->>'flat_cents') is not null)
                then max((i.shipping_options->>'flat_cents')::integer) end
      into v_shipping from public.inventory i where i.id = any(p_ids);
  else
    select i.pickup_show_id into v_pickup from public.inventory i where i.id = p_ids[1];
  end if;

  v_confirm := case when public._dealer_at_show(v_dealer) then public._order_setting('order_confirm_show_minutes', 15)
                    else public._order_setting('order_confirm_minutes', 120) end;
  v_confirm_by := now() + make_interval(mins => v_confirm);

  insert into public.listing_reservations (buyer_id, dealer_id, listing_ids, reason, expires_at, actor_type, actor_id,
                                           buyer_name, buyer_contact, buyer_note, agreed_cents, offer_id, placed_notice_at)
  values (p_buyer, v_dealer, p_ids, 'buy_now', v_confirm_by + interval '1 day', 'buyer', p_buyer::text,
          p_name, p_contact, p_note, p_subtotal, p_offer_id, now())
  returning id into v_res;
  perform set_config('cardshow.listing_fn', 'on', true);
  update public.inventory set listing_status = 'reserved', reserved_until = v_confirm_by, reserved_by = p_buyer, reservation_id = v_res
   where id = any(p_ids);
  perform set_config('cardshow.listing_fn', 'off', true);
  perform public._listing_log(p_ids, v_dealer, 'reserved', 'active', 'reserved', v_res, 'buyer', p_buyer::text,
                              jsonb_build_object('reason', 'buy_now', 'order_id', v_id, 'subtotal_cents', p_subtotal));

  insert into public.orders (id, buyer_id, dealer_id, listing_ids, fulfillment, ship_to, pickup_show_id, subtotal_cents,
                             shipping_cents, buyer_name, buyer_contact, buyer_note, confirm_by, pickup_code, reservation_id,
                             offer_id, from_reservation_id)
  values (v_id, p_buyer, v_dealer, p_ids, p_fulfillment, v_ship, v_pickup, p_subtotal,
          case when p_fulfillment = 'ship' then v_shipping end, p_name, p_contact, p_note, v_confirm_by,
          lpad((floor(random() * 1000000))::int::text, 6, '0'), v_res, p_offer_id, p_from_reservation);
  perform public._order_event(v_id, 'new', 'dealer');
  return jsonb_build_object('ok', true, 'order_id', v_id, 'status', 'awaiting_confirmation', 'confirm_by', v_confirm_by,
                            'subtotal_cents', p_subtotal,
                            'shipping_cents', case when p_fulfillment = 'ship' then v_shipping end);
end $$;

-- ── Buyer: Buy Now ────────────────────────────────────────────────────────────
-- Returns { ok, order_id, confirm_by, ... } or { error: not_signed_in | missing_name | missing_contact |
-- bad_fulfillment | not_found | own_listing | unavailable | early_access | no_price | fulfillment_not_offered |
-- bad_address | order_limit_day | reservation_limit }.
create or replace function public.place_order(p_listing_id uuid, p_fulfillment text, p_name text, p_contact text,
                                              p_note text default null, p_ship_to jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_name text := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 60);
  v_contact text := left(btrim(regexp_replace(coalesce(p_contact, ''), '\s+', ' ', 'g')), 120);
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
  c record;
  v_res public.listing_reservations;
  v_cap integer;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  if p_fulfillment not in ('ship','local_pickup') then return jsonb_build_object('error', 'bad_fulfillment'); end if;
  if length(v_name) < 1 then return jsonb_build_object('error', 'missing_name'); end if;
  if length(v_contact) < 3 then return jsonb_build_object('error', 'missing_contact'); end if;

  select * into c from public.inventory where id = p_listing_id for update;
  if c.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if c.seller_id = v_uid then return jsonb_build_object('error', 'own_listing'); end if;

  -- The buyer's own hold or accepted offer on this card becomes the order (at the agreed price).
  if c.listing_status = 'reserved' and c.reserved_by = v_uid and c.reservation_id is not null then
    select * into v_res from public.listing_reservations where id = c.reservation_id;
    if v_res.status = 'active' and v_res.reason in ('hold','offer_accepted') then
      return public.order_from_hold(v_res.id, p_fulfillment, p_ship_to, v_name, v_contact, v_note);
    end if;
    if v_res.reason = 'buy_now' and v_res.status = 'active' then
      return jsonb_build_object('error', 'already_ordered', 'order_id', (select id from public.orders where reservation_id = v_res.id));
    end if;
  end if;
  -- A hold past its end that the sweep hasn't reached yet ends now.
  if c.listing_status = 'reserved' and c.reserved_until <= now() and c.reservation_id is not null then
    select * into v_res from public.listing_reservations where id = c.reservation_id;
    if v_res.reason in ('hold','offer_accepted') then
      perform public._release_reservation(c.reservation_id, 'expired', 'hold expired', 'system', null);
      select * into c from public.inventory where id = p_listing_id;
    end if;
  end if;

  if c.status = 'Sold' or c.listing_status <> 'active' or coalesce(to_jsonb(c)->>'trust_flag', '') in ('flagged','disputed') then
    return jsonb_build_object('error', 'unavailable');
  end if;
  if c.early_access_until > now() then return jsonb_build_object('error', 'early_access'); end if;
  if coalesce(c.price_cents, 0) <= 0 then return jsonb_build_object('error', 'no_price'); end if;

  perform pg_advisory_xact_lock(hashtext('listing_order:' || v_uid::text));
  if (select count(*) from public.orders where buyer_id = v_uid and created_at > now() - interval '1 day')
       >= public._order_setting('max_orders_per_day', 20) then
    return jsonb_build_object('error', 'order_limit_day');
  end if;
  v_cap := public._order_setting('max_reserved_cards_per_buyer', 10);
  if (select count(*) from public.inventory where reserved_by = v_uid and listing_status = 'reserved') >= v_cap then
    return jsonb_build_object('error', 'reservation_limit', 'limit', v_cap);
  end if;

  return public._order_create(array[c.id], v_uid, c.price_cents, p_fulfillment, v_name, v_contact, v_note, p_ship_to, null, null);
end $$;

-- ── Buyer: turn my hold / accepted offer into an order ────────────────────────
create or replace function public.order_from_hold(p_reservation_id uuid, p_fulfillment text, p_ship_to jsonb default null,
                                                  p_name text default null, p_contact text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  r public.listing_reservations;
  v_price integer;
  v_name text; v_contact text; v_note text;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  if p_fulfillment not in ('ship','local_pickup') then return jsonb_build_object('error', 'bad_fulfillment'); end if;
  select * into r from public.listing_reservations where id = p_reservation_id for update;
  if r.id is null or r.buyer_id <> v_uid or r.reason not in ('hold','offer_accepted') then return jsonb_build_object('error', 'not_found'); end if;
  if r.status <> 'active' or r.expires_at <= now() then return jsonb_build_object('error', 'hold_ended'); end if;
  perform 1 from public.inventory where id = any(r.listing_ids) order by id for update;
  if exists (select 1 from public.inventory where id = any(r.listing_ids)
              and (status = 'Sold' or reservation_id is distinct from r.id)) then
    return jsonb_build_object('error', 'unavailable');
  end if;
  select coalesce(r.agreed_cents, sum(price_cents))::integer into v_price from public.inventory where id = any(r.listing_ids);
  v_name := coalesce(nullif(left(btrim(coalesce(p_name, '')), 60), ''), r.buyer_name);
  v_contact := coalesce(nullif(left(btrim(coalesce(p_contact, '')), 120), ''), r.buyer_contact);
  v_note := coalesce(nullif(left(btrim(coalesce(p_note, '')), 300), ''), r.buyer_note);
  if coalesce(length(v_name), 0) < 1 then return jsonb_build_object('error', 'missing_name'); end if;
  if coalesce(length(v_contact), 0) < 3 then return jsonb_build_object('error', 'missing_contact'); end if;
  -- Check delivery first, so a bad address doesn't end the hold.
  if exists (select 1 from public.inventory i where i.id = any(r.listing_ids)
              and not (p_fulfillment = any(coalesce(i.sale_modes, array['ship']::text[])))) then
    return jsonb_build_object('error', 'fulfillment_not_offered');
  end if;
  if p_fulfillment = 'ship' and public._order_ship_to(p_ship_to) is null then return jsonb_build_object('error', 'bad_address'); end if;

  perform public._release_reservation(r.id, 'converted', 'ordered', 'buyer', v_uid::text);
  return public._order_create(r.listing_ids, v_uid, v_price, p_fulfillment, v_name, v_contact, v_note, p_ship_to, r.offer_id, r.id);
end $$;

-- ── Dealer: confirm (still have it) ───────────────────────────────────────────
-- p_shipping_cents is required for a shipped order whose cards have no flat shipping price.
create or replace function public.confirm_order(p_order_id uuid, p_shipping_cents integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  o public.orders;
  v_pay_by timestamptz;
  v_ship integer;
  v_show_end timestamptz;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into o from public.orders where id = p_order_id for update;
  if o.id is null or o.dealer_id <> v_uid then return jsonb_build_object('error', 'not_found'); end if;
  if o.status <> 'awaiting_confirmation' then return jsonb_build_object('error', 'not_awaiting', 'status', public._order_status(o)); end if;
  if o.confirm_by <= now() then
    perform public._order_end(o.id, 'expired', 'not_confirmed', 'active');
    perform public._order_event(o.id, 'expired', 'buyer');
    return jsonb_build_object('error', 'expired');
  end if;
  if exists (select 1 from public.inventory where id = any(o.listing_ids) and (status = 'Sold' or reservation_id is distinct from o.reservation_id)) then
    return jsonb_build_object('error', 'unavailable');
  end if;
  v_ship := o.shipping_cents;
  if o.fulfillment = 'ship' then
    if p_shipping_cents is not null then
      if p_shipping_cents < 0 or p_shipping_cents > 100000 then return jsonb_build_object('error', 'bad_shipping'); end if;
      v_ship := p_shipping_cents;
    end if;
    if v_ship is null then return jsonb_build_object('error', 'shipping_required'); end if;
    v_pay_by := now() + make_interval(mins => public._order_setting('order_pay_minutes', 1440));
  else
    -- Pickup: pay by the end of the pickup show (its last day, in its time zone), else within a few days.
    select ((coalesce(s.end_date, s.start_date) + 1)::timestamp
             at time zone coalesce(nullif(to_jsonb(s)->>'timezone', ''), 'America/Los_Angeles'))
      into v_show_end from public.shows s where s.id = o.pickup_show_id;
    v_pay_by := greatest(coalesce(v_show_end, now() + make_interval(days => public._order_setting('order_pickup_pay_days', 3))),
                         now() + interval '1 hour');
  end if;
  update public.orders set status = 'awaiting_payment', shipping_cents = v_ship, confirmed_at = now(), pay_by = v_pay_by,
         updated_at = now() where id = o.id;
  update public.listing_reservations set expires_at = v_pay_by + interval '1 day' where id = o.reservation_id;
  perform set_config('cardshow.listing_fn', 'on', true);
  update public.inventory set reserved_until = v_pay_by where reservation_id = o.reservation_id;
  perform set_config('cardshow.listing_fn', 'off', true);
  perform public._order_event(o.id, 'confirmed', 'buyer');
  return jsonb_build_object('ok', true, 'status', 'awaiting_payment', 'pay_by', v_pay_by, 'shipping_cents', v_ship);
end $$;

-- ── Dealer: cancel ────────────────────────────────────────────────────────────
-- p_reason: not_available (the card comes off sale) | not_paid (only once confirmed) | dealer_cancelled.
create or replace function public.dealer_cancel_order(p_order_id uuid, p_reason text default 'not_available')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); o public.orders;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  if p_reason not in ('not_available','not_paid','dealer_cancelled') then return jsonb_build_object('error', 'bad_reason'); end if;
  select * into o from public.orders where id = p_order_id for update;
  if o.id is null or o.dealer_id <> v_uid then return jsonb_build_object('error', 'not_found'); end if;
  if o.status not in ('awaiting_confirmation','awaiting_payment') then return jsonb_build_object('error', 'not_open', 'status', o.status); end if;
  if p_reason = 'not_paid' and o.status <> 'awaiting_payment' then return jsonb_build_object('error', 'bad_reason'); end if;
  perform public._order_end(o.id, 'cancelled', p_reason, case when p_reason = 'not_available' then 'delisted' else 'active' end);
  perform public._order_event(o.id, 'cancelled', 'buyer');
  return jsonb_build_object('ok', true, 'status', 'cancelled');
end $$;

-- ── Buyer: cancel (before paying) ─────────────────────────────────────────────
create or replace function public.cancel_order(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); o public.orders;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into o from public.orders where id = p_order_id for update;
  if o.id is null or o.buyer_id <> v_uid then return jsonb_build_object('error', 'not_found'); end if;
  if o.status not in ('awaiting_confirmation','awaiting_payment') then return jsonb_build_object('error', 'not_open', 'status', o.status); end if;
  perform public._order_end(o.id, 'cancelled', 'buyer_cancelled', 'active');
  perform public._order_event(o.id, 'cancelled', 'dealer');
  return jsonb_build_object('ok', true, 'status', 'cancelled');
end $$;

-- ── Dealer: paid (cards sold); for pickup, optionally picked up in the same tap ─
create or replace function public.mark_order_paid(p_order_id uuid, p_payment_method text default null,
                                                  p_picked_up boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  o public.orders;
  v_r jsonb;
  v_method text := nullif(left(btrim(coalesce(p_payment_method, '')), 40), '');
  v_total bigint;
  v_has_sold_date boolean;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into o from public.orders where id = p_order_id for update;
  if o.id is null or o.dealer_id <> v_uid then return jsonb_build_object('error', 'not_found'); end if;
  if o.status = 'paid' and p_picked_up and o.fulfillment = 'local_pickup' then
    update public.orders set status = 'completed', completed_at = now(), updated_at = now() where id = o.id;
    return jsonb_build_object('ok', true, 'status', 'completed');
  end if;
  -- Paying at the table before the dealer tapped Confirm is fine: marking it paid confirms it.
  if o.status not in ('awaiting_confirmation','awaiting_payment') then return jsonb_build_object('error', 'not_open', 'status', o.status); end if;
  if o.fulfillment = 'ship' and o.shipping_cents is null then return jsonb_build_object('error', 'shipping_required'); end if;

  v_r := public.mark_sold(o.listing_ids, 'cardshow', o.reservation_id);
  if v_r ? 'error' then return v_r; end if;

  -- What each card sold for (the order's price split by asking price, leftover cents to the priciest card),
  -- so the seller's Report and Show Home read it like any other sale.
  select sum(price_cents) into v_total from public.inventory where id = any(o.listing_ids);
  with s as (
    select id, price_cents,
           floor(o.subtotal_cents::numeric * price_cents / nullif(v_total, 0))::integer as share,
           row_number() over (order by price_cents desc, id) as rn
      from public.inventory where id = any(o.listing_ids)),
  t as (select o.subtotal_cents - sum(share) as leftover from s)
  update public.inventory i set
    sold_price = ((s.share + case when s.rn = 1 then t.leftover else 0 end) / 100.0),
    payment_method = coalesce(v_method, 'Marketplace')
    from s, t where i.id = s.id;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory'
                  and column_name = 'sold_date') into v_has_sold_date;
  if v_has_sold_date then
    execute 'update public.inventory set sold_date = to_char(now() at time zone ''America/Los_Angeles'', ''YYYY-MM-DD'') where id = any($1)'
      using o.listing_ids;
  end if;

  update public.orders set status = case when p_picked_up and o.fulfillment = 'local_pickup' then 'completed' else 'paid' end,
         confirmed_at = coalesce(confirmed_at, now()), paid_at = now(),
         completed_at = case when p_picked_up and o.fulfillment = 'local_pickup' then now() end,
         payment_method = v_method, updated_at = now()
   where id = o.id;
  perform public._order_event(o.id, 'paid', 'buyer');
  return jsonb_build_object('ok', true, 'status', case when p_picked_up and o.fulfillment = 'local_pickup' then 'completed' else 'paid' end,
                            'listing_ids', to_jsonb(o.listing_ids));
end $$;

-- ── Dealer: shipped ───────────────────────────────────────────────────────────
create or replace function public.ship_order(p_order_id uuid, p_carrier text, p_tracking text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); o public.orders;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into o from public.orders where id = p_order_id for update;
  if o.id is null or o.dealer_id <> v_uid then return jsonb_build_object('error', 'not_found'); end if;
  if o.fulfillment <> 'ship' or o.status not in ('paid','shipped') then return jsonb_build_object('error', 'not_paid', 'status', o.status); end if;
  if length(btrim(coalesce(p_tracking, ''))) < 4 then return jsonb_build_object('error', 'missing_tracking'); end if;
  update public.orders set status = 'shipped', shipped_at = coalesce(shipped_at, now()),
         carrier = nullif(left(btrim(coalesce(p_carrier, '')), 30), ''), tracking_number = left(btrim(p_tracking), 60),
         updated_at = now()
   where id = o.id;
  if o.status = 'paid' then perform public._order_event(o.id, 'shipped', 'buyer'); end if;
  return jsonb_build_object('ok', true, 'status', 'shipped');
end $$;

-- ── Buyer: got it ─────────────────────────────────────────────────────────────
create or replace function public.order_received(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); o public.orders;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into o from public.orders where id = p_order_id for update;
  if o.id is null or o.buyer_id <> v_uid then return jsonb_build_object('error', 'not_found'); end if;
  if o.status = 'completed' then return jsonb_build_object('ok', true, 'already', true); end if;
  if o.status <> 'shipped' then return jsonb_build_object('error', 'not_shipped', 'status', o.status); end if;
  update public.orders set status = 'completed', completed_at = now(), updated_at = now() where id = o.id;
  return jsonb_build_object('ok', true, 'status', 'completed');
end $$;

-- ── Lists ─────────────────────────────────────────────────────────────────────
create or replace function public._order_json(o public.orders, p_for text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', o.id, 'status', public._order_status(o),
    'end_reason', case when public._order_status(o) = 'expired' and o.status not in ('expired')
                       then case o.status when 'awaiting_confirmation' then 'not_confirmed' else 'not_paid' end
                       else o.end_reason end,
    'fulfillment', o.fulfillment, 'listing_ids', to_jsonb(o.listing_ids), 'card_count', cardinality(o.listing_ids),
    'subtotal_cents', o.subtotal_cents, 'shipping_cents', o.shipping_cents,
    'total_cents', o.subtotal_cents + coalesce(o.shipping_cents, 0) + o.buyer_fee_cents,
    'from_offer', o.offer_id is not null,
    'confirm_by', o.confirm_by, 'pay_by', o.pay_by,
    'created_at', o.created_at, 'confirmed_at', o.confirmed_at, 'paid_at', o.paid_at, 'shipped_at', o.shipped_at,
    'completed_at', o.completed_at, 'ended_at', o.ended_at, 'updated_at', o.updated_at,
    'carrier', o.carrier, 'tracking_number', o.tracking_number, 'payment_method', o.payment_method,
    'ship_to', o.ship_to,
    'pickup_code', case when p_for = 'buyer' then o.pickup_code end,
    'pickup_show', (select jsonb_strip_nulls(jsonb_build_object('id', s.id, 'name', s.name, 'date', s.date,
                              'city', s.city, 'state', s.state, 'venue', s.venue,
                              'table_number', (select ss.table_number from public.show_sellers ss
                                                where ss.show_id = s.id and ss.seller_id = o.dealer_id)))
                      from public.shows s where s.id = o.pickup_show_id),
    'buyer_name', o.buyer_name, 'buyer_note', o.buyer_note,
    'buyer_contact', case when p_for = 'dealer' then o.buyer_contact end))
$$;

create or replace function public.my_orders()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'status') in ('awaiting_confirmation','awaiting_payment','paid','shipped') desc, x->>'created_at' desc)
      from (
        select public._order_json(o, 'buyer') || jsonb_strip_nulls(jsonb_build_object(
                 'cards', (select coalesce(jsonb_agg(public._listing_json(c.id, true) order by c.ord), '[]'::jsonb)
                             from unnest(o.listing_ids) with ordinality c(id, ord)),
                 'dealer', (select jsonb_strip_nulls(jsonb_build_object('handle', s.handle,
                               'display_name', coalesce(nullif(s.display_name, ''), s.handle)))
                              from public.sellers s where s.id = o.dealer_id),
                 -- How to pay: only once the dealer has confirmed.
                 'payment', case when o.status in ('awaiting_payment','paid','shipped','completed') then
                              (select jsonb_build_object('methods', p.methods, 'note', p.note)
                                 from public.dealer_payment_methods p where p.dealer_id = o.dealer_id) end)) x
          from public.orders o
         where o.buyer_id = v_uid and o.created_at > now() - interval '90 days'
         order by o.created_at desc limit 100) q), '[]'::jsonb);
end $$;

create or replace function public.dealer_orders()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'status') = 'awaiting_confirmation' desc, (x->>'status') = 'awaiting_payment' desc,
                                (x->>'status') = 'paid' desc, x->>'created_at' desc)
      from (
        select public._order_json(o, 'dealer') || jsonb_build_object(
                 'cards', (select coalesce(jsonb_agg(public._offer_dealer_card(c.id) order by c.ord), '[]'::jsonb)
                             from unnest(o.listing_ids) with ordinality c(id, ord))) x
          from public.orders o
         where o.dealer_id = v_uid
           and (o.status in ('awaiting_confirmation','awaiting_payment','paid','shipped') or o.updated_at > now() - interval '7 days')
         order by o.created_at desc limit 200) q), '[]'::jsonb);
end $$;

-- ── Sweep (service role; the 5-minute job, before expire_listing_reservations) ─
create or replace function public.expire_orders()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  if not public._listing_is_service() and current_user in ('anon','authenticated') then raise exception 'service_only'; end if;
  -- The card was sold at the table (or otherwise lost) while ordered.
  for r in select o.id from public.orders o join public.listing_reservations lr on lr.id = o.reservation_id
            where o.status in ('awaiting_confirmation','awaiting_payment') and lr.status <> 'active'
            for update of o skip locked loop
    update public.orders set status = 'cancelled', end_reason = 'sold_elsewhere', ended_at = now(), updated_at = now() where id = r.id;
    perform public._order_event(r.id, 'cancelled', 'buyer');
    n := n + 1;
  end loop;
  for r in select id, status from public.orders
            where (status = 'awaiting_confirmation' and confirm_by <= now()) or (status = 'awaiting_payment' and pay_by <= now())
            for update skip locked loop
    perform public._order_end(r.id, 'expired', case r.status when 'awaiting_confirmation' then 'not_confirmed' else 'not_paid' end, 'active');
    perform public._order_event(r.id, 'expired', 'buyer');
    perform public._order_event(r.id, 'expired', 'dealer');
    n := n + 1;
  end loop;
  update public.orders set status = 'completed', completed_at = now(), updated_at = now(), end_reason = 'auto_completed'
   where status = 'shipped'
     and shipped_at <= now() - make_interval(days => public._order_setting('order_auto_complete_days', 14));
  return n;
end $$;

-- ── Emails ────────────────────────────────────────────────────────────────────
create or replace function public.order_notices_due(p_limit integer default 50, p_order_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public._listing_is_service() and current_user in ('anon','authenticated') then raise exception 'service_only'; end if;
  return coalesce((
    select jsonb_agg(n) from (
      select public._order_json(o, 'dealer') || jsonb_strip_nulls(jsonb_build_object(
               'event_id', e.id, 'order_id', o.id, 'kind', e.kind, 'to', e.to_whom,
               'email', case e.to_whom when 'dealer' then (select s.email from public.sellers s where s.id = o.dealer_id)
                                       else (select u.email from auth.users u where u.id = o.buyer_id) end,
               'dealer', (select jsonb_strip_nulls(jsonb_build_object('handle', s.handle,
                              'display_name', coalesce(nullif(s.display_name, ''), s.handle)))
                            from public.sellers s where s.id = o.dealer_id),
               'payment', (select jsonb_build_object('methods', p.methods, 'note', p.note)
                             from public.dealer_payment_methods p where p.dealer_id = o.dealer_id),
               'cards', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', i.id, 'title', i.card_title,
                            'price_cents', i.price_cents, 'stock_code', to_jsonb(i)->>'stock_code',
                            'url', '/c/' || i.id || '-' || public._listing_slug(i.card_title))) order by c.ord), '[]'::jsonb)
                          from unnest(o.listing_ids) with ordinality c(id, ord) join public.inventory i on i.id = c.id))) n
        from public.order_events e join public.orders o on o.id = e.order_id
       where e.sent_at is null and e.created_at > now() - interval '2 days'
         and (p_order_id is null or o.id = p_order_id)
       order by e.created_at
       limit greatest(1, least(coalesce(p_limit, 50), 200))) q), '[]'::jsonb);
end $$;

create or replace function public.order_notice_sent(p_event_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.order_events set sent_at = now() where id = p_event_id and sent_at is null $$;

create or replace function public.order_party(p_order_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.orders where id = p_order_id and p_user in (buyer_id, dealer_id)) $$;

-- ── Grants ────────────────────────────────────────────────────────────────────
revoke all on function public._order_event(uuid, text, text) from public, anon, authenticated;
revoke all on function public._order_setting(text, integer) from public, anon, authenticated;
revoke all on function public._order_end(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public._order_create(uuid[], uuid, integer, text, text, text, text, jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function public._order_json(public.orders, text) from public, anon, authenticated;
revoke all on function public.expire_orders() from public, anon, authenticated;
revoke all on function public.order_notices_due(integer, uuid) from public, anon, authenticated;
revoke all on function public.order_notice_sent(uuid) from public, anon, authenticated;
revoke all on function public.order_party(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_payment_methods(jsonb, text) from public, anon;
revoke all on function public.place_order(uuid, text, text, text, text, jsonb) from public, anon;
revoke all on function public.order_from_hold(uuid, text, jsonb, text, text, text) from public, anon;
revoke all on function public.confirm_order(uuid, integer) from public, anon;
revoke all on function public.dealer_cancel_order(uuid, text) from public, anon;
revoke all on function public.cancel_order(uuid) from public, anon;
revoke all on function public.mark_order_paid(uuid, text, boolean) from public, anon;
revoke all on function public.ship_order(uuid, text, text) from public, anon;
revoke all on function public.order_received(uuid) from public, anon;
revoke all on function public.my_orders() from public, anon;
revoke all on function public.dealer_orders() from public, anon;
grant execute on function public.set_payment_methods(jsonb, text) to authenticated;
grant execute on function public.place_order(uuid, text, text, text, text, jsonb) to authenticated;
grant execute on function public.order_from_hold(uuid, text, jsonb, text, text, text) to authenticated;
grant execute on function public.confirm_order(uuid, integer) to authenticated;
grant execute on function public.dealer_cancel_order(uuid, text) to authenticated;
grant execute on function public.cancel_order(uuid) to authenticated;
grant execute on function public.mark_order_paid(uuid, text, boolean) to authenticated;
grant execute on function public.ship_order(uuid, text, text) to authenticated;
grant execute on function public.order_received(uuid) to authenticated;
grant execute on function public.my_orders() to authenticated;
grant execute on function public.dealer_orders() to authenticated;
grant execute on function public.expire_orders() to service_role;
grant execute on function public.order_notices_due(integer, uuid) to service_role;
grant execute on function public.order_notice_sent(uuid) to service_role;
grant execute on function public.order_party(uuid, uuid) to service_role;

commit;
