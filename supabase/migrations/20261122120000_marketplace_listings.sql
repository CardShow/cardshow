-- CardShow Marketplace, Phase 0: listing data model + status functions.
-- See CLAUDE.md "CardShow Marketplace" and docs/marketplace-plan-v3.md. Re-runnable.
--
-- Ground rules this file enforces:
-- * One inventory record per card. Listing fields live on public.inventory; nothing is copied.
-- * A card can only be sold once. listing_status (and the other status fields below) only
--   change inside the functions in this file, which lock the rows they touch. A trigger refuses
--   any other write to those fields from the API roles (anon / authenticated / service_role),
--   including from other SECURITY DEFINER functions such as record_sale().
-- * Existing dealer-app sales keep working unchanged: when inventory.status becomes 'Sold' by
--   any path (Sell Drawer, Show Mode, trades, imports), a trigger marks the listing sold and,
--   if a buyer was holding it, ends that hold (logged as 'reservation_broken'). An undo puts the
--   listing back where it was.
-- * New money columns are integer cents. inventory.price (dollars) stays the asking price;
--   price_cents is generated from it so the two can never disagree.
--
-- Differences from the plan's sketch (docs/marketplace-plan-v3.md, Phase 0):
-- * shows.id is text, so the pickup show column is text. It is named pickup_show_id (not show_id)
--   so it isn't confused with show_inventory, which is still how a card joins a show.
-- * reserved_by / reservation_id are added next to reserved_until, and a small
--   listing_reservations table holds each hold (one hold can cover several cards: lots,
--   multi-card offers). listing_events logs every status change and who made it.
-- * lot_id / shop_id have no foreign key yet (lots and shops tables come in Phase 3 / later).

begin;

-- ── Settings (service role only) ──────────────────────────────────────────────
create table if not exists public.marketplace_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.marketplace_settings enable row level security;
revoke all on public.marketplace_settings from anon, authenticated;
insert into public.marketplace_settings (key, value) values
  ('max_reserved_cards_per_buyer', '10'::jsonb),
  ('max_hold_minutes', '10080'::jsonb)
on conflict (key) do nothing;

-- ── Reservations + event log ──────────────────────────────────────────────────
create table if not exists public.listing_reservations (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null,
  dealer_id uuid not null,
  listing_ids uuid[] not null,
  reason text not null check (reason in ('buy_now','offer_accepted','local_pickup','lot','wholesale','checkout')),
  status text not null default 'active' check (status in ('active','released','expired','converted','broken')),
  expires_at timestamptz not null,
  actor_type text not null default 'buyer' check (actor_type in ('buyer','dealer','system','buyer_agent','dealer_agent','repacker_agent','external_agent')),
  actor_id text,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text
);
create index if not exists listing_reservations_active_idx on public.listing_reservations (status, expires_at);
create index if not exists listing_reservations_buyer_idx on public.listing_reservations (buyer_id, status);
alter table public.listing_reservations enable row level security;
drop policy if exists listing_reservations_read_own on public.listing_reservations;
create policy listing_reservations_read_own on public.listing_reservations
  for select to authenticated using (buyer_id = auth.uid() or dealer_id = auth.uid());
revoke insert, update, delete on public.listing_reservations from anon, authenticated;

create table if not exists public.listing_events (
  id bigint generated always as identity primary key,
  listing_id uuid not null,
  dealer_id uuid,
  action text not null,
  from_status text,
  to_status text,
  reservation_id uuid,
  actor_type text,
  actor_id text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists listing_events_listing_idx on public.listing_events (listing_id, created_at);
alter table public.listing_events enable row level security;
drop policy if exists listing_events_read_own on public.listing_events;
create policy listing_events_read_own on public.listing_events
  for select to authenticated using (dealer_id = auth.uid() or actor_id = auth.uid()::text);
revoke insert, update, delete on public.listing_events from anon, authenticated;

-- ── Listing columns on inventory ──────────────────────────────────────────────
alter table public.inventory
  add column if not exists listing_status text not null default 'draft',
  add column if not exists comp_value_cents integer,
  add column if not exists min_offer_cents integer,
  add column if not exists auto_accept_cents integer,
  add column if not exists accepts_offers boolean default true,
  add column if not exists wholesale_eligible boolean default true,
  add column if not exists sale_modes text[] default '{ship}',
  add column if not exists shipping_options jsonb,
  add column if not exists location_type text,
  add column if not exists pickup_show_id text,
  add column if not exists shop_id uuid,
  add column if not exists table_label text,
  add column if not exists early_access_until timestamptz,
  add column if not exists lot_id uuid,
  add column if not exists availability_confirmed_at timestamptz,
  add column if not exists reserved_until timestamptz,
  add column if not exists reserved_by uuid,
  add column if not exists reservation_id uuid,
  add column if not exists sold_at timestamptz,
  add column if not exists sold_channel text,
  add column if not exists listing_status_before_sale text;

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'price_cents') then
    alter table public.inventory add column price_cents integer generated always as (case when price is null then null else round(price * 100)::integer end) stored;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_listing_status_check') then
    alter table public.inventory add constraint inventory_listing_status_check
      check (listing_status in ('draft','active','reserved','sold','delisted'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_sold_channel_check') then
    alter table public.inventory add constraint inventory_sold_channel_check
      check (sold_channel is null or sold_channel in ('cardshow','ebay','shopify','in_person','partner','agent'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_location_type_check') then
    alter table public.inventory add constraint inventory_location_type_check
      check (location_type is null or location_type in ('show','shop','none'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_listing_cents_check') then
    alter table public.inventory add constraint inventory_listing_cents_check
      check (coalesce(comp_value_cents, 0) >= 0 and coalesce(min_offer_cents, 0) >= 0 and coalesce(auto_accept_cents, 0) >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_pickup_show_fk') then
    alter table public.inventory add constraint inventory_pickup_show_fk
      foreign key (pickup_show_id) references public.shows(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_reservation_fk') then
    alter table public.inventory add constraint inventory_reservation_fk
      foreign key (reservation_id) references public.listing_reservations(id) on delete set null;
  end if;
end $$;

create index if not exists inventory_listing_status_idx on public.inventory (listing_status) where listing_status in ('active','reserved');
create index if not exists inventory_reservation_idx on public.inventory (reservation_id) where reservation_id is not null;

-- ── Helpers ───────────────────────────────────────────────────────────────────
-- True inside one of this file's functions (they set the flag for their own transaction),
-- or for a direct SQL session as the database owner (SQL editor). Never true for an API call.
create or replace function public._listing_write_allowed() returns boolean
language sql stable as $$
  select coalesce(current_setting('cardshow.listing_fn', true), '') = 'on'
      or (session_user = current_user and current_user not in ('anon','authenticated','service_role','authenticator'))
$$;

create or replace function public._listing_is_service() returns boolean
language sql stable as $$
  select coalesce(current_setting('role', true), '') = 'service_role'
      or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') = 'service_role'
$$;

create or replace function public._listing_setting(p_key text, p_default jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.marketplace_settings where key = p_key), p_default)
$$;
revoke all on function public._listing_setting(text, jsonb) from public, anon, authenticated;

create or replace function public._listing_log(p_ids uuid[], p_dealer uuid, p_action text, p_from text, p_to text,
                                               p_reservation uuid, p_actor_type text, p_actor_id text, p_detail jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.listing_events (listing_id, dealer_id, action, from_status, to_status, reservation_id, actor_type, actor_id, detail)
  select x, p_dealer, p_action, p_from, p_to, p_reservation, p_actor_type, p_actor_id, p_detail from unnest(p_ids) x
$$;
revoke all on function public._listing_log(uuid[], uuid, text, text, text, uuid, text, text, jsonb) from public, anon, authenticated;

-- ── Triggers on inventory ─────────────────────────────────────────────────────
-- (a) guard: runs first (BEFORE triggers fire in name order) and checks what the caller sent.
create or replace function public._inv_listing_guard() returns trigger
language plpgsql as $$
begin
  if public._listing_write_allowed() then return new; end if;
  if tg_op = 'INSERT' then
    if new.listing_status <> 'draft' or new.reserved_until is not null or new.reserved_by is not null
       or new.reservation_id is not null or new.sold_at is not null or new.sold_channel is not null
       or new.listing_status_before_sale is not null then
      raise exception 'listing_status_locked' using hint = 'New cards start as draft; publish with publish_listings().';
    end if;
  elsif new.listing_status is distinct from old.listing_status
     or new.reserved_until is distinct from old.reserved_until
     or new.reserved_by is distinct from old.reserved_by
     or new.reservation_id is distinct from old.reservation_id
     or new.sold_at is distinct from old.sold_at
     or new.sold_channel is distinct from old.sold_channel
     or new.listing_status_before_sale is distinct from old.listing_status_before_sale then
    raise exception 'listing_status_locked' using hint = 'Listing status only changes through the listing functions.';
  end if;
  return new;
end $$;

-- (b) sync: keeps the listing in step with sales made outside the marketplace, and with GTCR.
create or replace function public._inv_listing_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_res uuid;
begin
  if tg_op <> 'UPDATE' then return new; end if;

  -- Sold by any existing path (table sale, Show Mode, trade, import).
  if new.status = 'Sold' and old.status is distinct from 'Sold' and new.listing_status <> 'sold' then
    v_res := new.reservation_id;
    new.listing_status_before_sale := new.listing_status;
    new.listing_status := 'sold';
    new.sold_at := coalesce(new.sold_at, now());
    new.sold_channel := coalesce(new.sold_channel, 'in_person');
    if v_res is not null then
      update public.listing_reservations set status = 'broken', ended_at = now(), end_reason = 'sold_elsewhere'
       where id = v_res and status = 'active';
      perform public._listing_log(array[new.id], new.seller_id, 'reservation_broken', 'reserved', 'sold', v_res, 'system', null,
                                  jsonb_build_object('sold_channel', new.sold_channel));
    end if;
    new.reserved_until := null; new.reserved_by := null; new.reservation_id := null;
    perform public._listing_log(array[new.id], new.seller_id, 'sold_outside', new.listing_status_before_sale, 'sold', null, 'dealer',
                                new.seller_id::text, jsonb_build_object('sold_channel', new.sold_channel));
    return new;
  end if;

  -- Undo of such a sale. A hold that was broken is not restored; a marketplace sale is not relisted.
  if old.status = 'Sold' and new.status is distinct from 'Sold' and new.listing_status = 'sold' then
    new.listing_status := case
      when coalesce(new.sold_channel, 'in_person') <> 'in_person' then 'delisted'
      when new.listing_status_before_sale = 'reserved' then 'active'
      else coalesce(new.listing_status_before_sale, 'draft') end;
    new.sold_at := null; new.sold_channel := null; new.listing_status_before_sale := null;
    perform public._listing_log(array[new.id], new.seller_id, 'sale_undone', 'sold', new.listing_status, null, 'dealer', new.seller_id::text, null);
  end if;

  -- A stolen/lost report takes an active listing down (reserved cards are refused at mark_sold).
  if new.listing_status = 'active' and to_jsonb(new)->>'trust_flag' = 'flagged'
     and to_jsonb(old)->>'trust_flag' is distinct from 'flagged' then
    new.listing_status := 'delisted';
    perform public._listing_log(array[new.id], new.seller_id, 'delisted_trust_flag', 'active', 'delisted', null, 'system', null, null);
  end if;
  return new;
end $$;

drop trigger if exists inv_listing_a_guard on public.inventory;
create trigger inv_listing_a_guard before insert or update on public.inventory
  for each row execute function public._inv_listing_guard();
drop trigger if exists inv_listing_b_sync on public.inventory;
create trigger inv_listing_b_sync before update on public.inventory
  for each row execute function public._inv_listing_sync();

-- ── Dealer: publish / delist ──────────────────────────────────────────────────
-- Returns { ok, published: [ids], skipped: [{id, reason}] }. Reasons: not_found, sold, reserved,
-- no_price, trust_flag, needs_details. Already-active cards count as published.
create or replace function public.publish_listings(p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_ok uuid[] := '{}'; v_skip jsonb := '[]'::jsonb; r record; v_why text;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then return jsonb_build_object('ok', true, 'published', '[]'::jsonb, 'skipped', '[]'::jsonb); end if;
  if cardinality(p_ids) > 1000 then raise exception 'too_many'; end if;
  perform set_config('cardshow.listing_fn', 'on', true);
  for r in select i.*, to_jsonb(i) j from public.inventory i
            where i.id = any(p_ids) and i.seller_id = v_uid order by i.id for update loop
    v_why := case
      when r.status = 'Sold' or r.listing_status = 'sold' then 'sold'
      when r.listing_status = 'reserved' then 'reserved'
      when r.j->>'trust_flag' in ('flagged','disputed') then 'trust_flag'
      when r.j->>'identification_status' = 'unidentified' then 'needs_details'
      when coalesce(r.price, 0) <= 0 then 'no_price'
      else null end;
    if v_why is not null then
      v_skip := v_skip || jsonb_build_object('id', r.id, 'reason', v_why);
    else
      if r.listing_status <> 'active' then
        update public.inventory set listing_status = 'active' where id = r.id;
        perform public._listing_log(array[r.id], v_uid, 'published', r.listing_status, 'active', null, 'dealer', v_uid::text, null);
      end if;
      v_ok := v_ok || r.id;
    end if;
  end loop;
  select v_skip || coalesce(jsonb_agg(jsonb_build_object('id', x, 'reason', 'not_found')), '[]'::jsonb) into v_skip
    from unnest(p_ids) x where not exists (select 1 from public.inventory i where i.id = x and i.seller_id = v_uid);
  perform set_config('cardshow.listing_fn', 'off', true);
  return jsonb_build_object('ok', true, 'published', to_jsonb(v_ok), 'skipped', v_skip);
end $$;

create or replace function public.delist_listings(p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_ok uuid[] := '{}'; v_skip jsonb := '[]'::jsonb; r record;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then return jsonb_build_object('ok', true, 'delisted', '[]'::jsonb, 'skipped', '[]'::jsonb); end if;
  perform set_config('cardshow.listing_fn', 'on', true);
  for r in select * from public.inventory where id = any(p_ids) and seller_id = v_uid order by id for update loop
    if r.listing_status in ('reserved','sold') then
      v_skip := v_skip || jsonb_build_object('id', r.id, 'reason', r.listing_status);
    else
      if r.listing_status = 'active' then
        update public.inventory set listing_status = 'delisted' where id = r.id;
        perform public._listing_log(array[r.id], v_uid, 'delisted', 'active', 'delisted', null, 'dealer', v_uid::text, null);
      end if;
      v_ok := v_ok || r.id;
    end if;
  end loop;
  select v_skip || coalesce(jsonb_agg(jsonb_build_object('id', x, 'reason', 'not_found')), '[]'::jsonb) into v_skip
    from unnest(p_ids) x where not exists (select 1 from public.inventory i where i.id = x and i.seller_id = v_uid);
  perform set_config('cardshow.listing_fn', 'off', true);
  return jsonb_build_object('ok', true, 'delisted', to_jsonb(v_ok), 'skipped', v_skip);
end $$;

-- ── Buyer / system: reserve ───────────────────────────────────────────────────
-- All cards or none. All cards must be one dealer's. A signed-in buyer may only reserve for
-- themselves; the service role (payments, agents later) may reserve for any buyer.
-- Returns { ok, reservation_id, expires_at, listing_ids }
--      or { error: 'unavailable'|'not_found'|'own_listing'|'multiple_dealers'|'early_access'|'reservation_limit', ... }.
create or replace function public.reserve_listings(p_listing_ids uuid[], p_buyer_id uuid, p_reason text,
                                                    p_hold_minutes integer default 15, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_service boolean := public._listing_is_service();
  v_ids uuid[];
  v_rows record;
  v_dealers uuid[];
  v_bad uuid[];
  v_found integer;
  v_cap integer := (public._listing_setting('max_reserved_cards_per_buyer', '10'::jsonb))::text::integer;
  v_max_hold integer := (public._listing_setting('max_hold_minutes', '10080'::jsonb))::text::integer;
  v_held integer;
  v_minutes integer;
  v_res uuid;
  v_exp timestamptz;
  v_actor_type text;
begin
  if not v_service then
    if v_uid is null then raise exception 'not_signed_in'; end if;
    if p_buyer_id is distinct from v_uid then raise exception 'not_your_account'; end if;
  end if;
  if p_buyer_id is null then raise exception 'missing_buyer'; end if;
  if p_reason not in ('buy_now','offer_accepted','local_pickup','lot','wholesale','checkout') then raise exception 'bad_reason'; end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_listing_ids) x where x is not null;
  if v_ids is null then raise exception 'no_listings'; end if;
  if cardinality(v_ids) > 200 then raise exception 'too_many'; end if;
  v_minutes := least(greatest(coalesce(p_hold_minutes, 15), 1), v_max_hold);
  v_actor_type := case when v_service and p_actor is not null then p_actor
                       when v_service then 'system' else 'buyer' end;
  if v_actor_type not in ('buyer','system','buyer_agent','repacker_agent','external_agent','dealer_agent') then
    raise exception 'bad_actor';
  end if;

  -- Lock every row in id order (no deadlocks between overlapping calls), then decide.
  perform 1 from public.inventory where id = any(v_ids) order by id for update;
  select count(*), array_agg(distinct seller_id),
         array_agg(id) filter (where listing_status <> 'active' or status = 'Sold'
                                  or coalesce(to_jsonb(inventory)->>'trust_flag', '') in ('flagged','disputed'))
    into v_found, v_dealers, v_bad
    from public.inventory where id = any(v_ids);

  if v_found <> cardinality(v_ids) then
    return jsonb_build_object('error', 'not_found',
      'missing', (select to_jsonb(array_agg(x)) from unnest(v_ids) x where not exists (select 1 from public.inventory i where i.id = x)));
  end if;
  if v_bad is not null then return jsonb_build_object('error', 'unavailable', 'unavailable', to_jsonb(v_bad)); end if;
  if cardinality(v_dealers) > 1 then return jsonb_build_object('error', 'multiple_dealers'); end if;
  if v_dealers[1] = p_buyer_id then return jsonb_build_object('error', 'own_listing'); end if;
  if not v_service and exists (select 1 from public.inventory where id = any(v_ids) and early_access_until > now()) then
    return jsonb_build_object('error', 'early_access');
  end if;

  -- Per-buyer cap on cards held at once (serialized per buyer so two calls can't both pass it).
  perform pg_advisory_xact_lock(hashtext('listing_hold:' || p_buyer_id::text));
  select coalesce(sum(cardinality(listing_ids)), 0) into v_held from public.listing_reservations
   where buyer_id = p_buyer_id and status = 'active' and expires_at > now();
  if v_held + cardinality(v_ids) > v_cap then
    return jsonb_build_object('error', 'reservation_limit', 'held', v_held, 'limit', v_cap);
  end if;

  v_exp := now() + make_interval(mins => v_minutes);
  insert into public.listing_reservations (buyer_id, dealer_id, listing_ids, reason, expires_at, actor_type, actor_id)
  values (p_buyer_id, v_dealers[1], v_ids, p_reason, v_exp, v_actor_type, coalesce(p_actor, v_uid::text))
  returning id into v_res;

  perform set_config('cardshow.listing_fn', 'on', true);
  update public.inventory set listing_status = 'reserved', reserved_until = v_exp, reserved_by = p_buyer_id, reservation_id = v_res
   where id = any(v_ids);
  perform set_config('cardshow.listing_fn', 'off', true);
  perform public._listing_log(v_ids, v_dealers[1], 'reserved', 'active', 'reserved', v_res, v_actor_type, coalesce(p_actor, v_uid::text),
                              jsonb_build_object('reason', p_reason, 'buyer_id', p_buyer_id, 'minutes', v_minutes));
  return jsonb_build_object('ok', true, 'reservation_id', v_res, 'expires_at', v_exp, 'listing_ids', to_jsonb(v_ids));
end $$;

create or replace function public.reserve_listing(p_listing_id uuid, p_buyer_id uuid, p_reason text,
                                                   p_hold_minutes integer default 15, p_actor text default null)
returns jsonb language sql security invoker set search_path = public as $$
  select public.reserve_listings(array[p_listing_id], p_buyer_id, p_reason, p_hold_minutes, p_actor)
$$;

-- ── Release (buyer, dealer, or system) ────────────────────────────────────────
-- Cards go back to active (to delisted if a stolen/lost report arrived meanwhile).
create or replace function public._release_reservation(p_reservation_id uuid, p_end_status text, p_reason text,
                                                        p_actor_type text, p_actor_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_res public.listing_reservations; v_ids uuid[];
begin
  select * into v_res from public.listing_reservations where id = p_reservation_id for update;
  if v_res.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if v_res.status <> 'active' then return jsonb_build_object('ok', true, 'already', true, 'status', v_res.status); end if;
  perform set_config('cardshow.listing_fn', 'on', true);
  with u as (
    update public.inventory i set
      listing_status = case when coalesce(to_jsonb(i)->>'trust_flag', '') = 'flagged' then 'delisted' else 'active' end,
      reserved_until = null, reserved_by = null, reservation_id = null
     where i.reservation_id = p_reservation_id and i.listing_status = 'reserved'
    returning i.id)
  select array_agg(id) into v_ids from u;
  perform set_config('cardshow.listing_fn', 'off', true);
  update public.listing_reservations set status = p_end_status, ended_at = now(), end_reason = left(coalesce(p_reason, p_end_status), 200)
   where id = p_reservation_id;
  if v_ids is not null then
    perform public._listing_log(v_ids, v_res.dealer_id, p_end_status, 'reserved', 'active', p_reservation_id,
                                p_actor_type, p_actor_id, jsonb_build_object('reason', p_reason));
  end if;
  return jsonb_build_object('ok', true, 'released', coalesce(to_jsonb(v_ids), '[]'::jsonb));
end $$;
revoke all on function public._release_reservation(uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.release_listing(p_reservation_id uuid, p_reason text default 'released')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_service boolean := public._listing_is_service();
  v_buyer uuid; v_dealer uuid;
begin
  select buyer_id, dealer_id into v_buyer, v_dealer from public.listing_reservations where id = p_reservation_id;
  if v_buyer is null then return jsonb_build_object('error', 'not_found'); end if;
  if not v_service and (v_uid is null or v_uid not in (v_buyer, v_dealer)) then raise exception 'not_your_reservation'; end if;
  return public._release_reservation(p_reservation_id, 'released', p_reason,
    case when v_service then 'system' when v_uid = v_dealer then 'dealer' else 'buyer' end, coalesce(v_uid::text, 'service'));
end $$;

-- ── Mark sold (marketplace and synced channels) ───────────────────────────────
-- For sales made through CardShow or another channel (eBay/Shopify sync later). In-person
-- sales keep using the dealer app; the sync trigger above handles those.
-- With p_reservation_id: every card must be held by that reservation (it becomes 'converted').
-- Without: every card must be unreserved and unsold. Caller: the service role, or the dealer.
create or replace function public.mark_sold(p_listing_ids uuid[], p_channel text, p_reservation_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_service boolean := public._listing_is_service();
  v_ids uuid[];
  v_found integer; v_dealers uuid[]; v_bad uuid[]; v_flagged uuid[];
  v_res public.listing_reservations;
begin
  if not v_service and v_uid is null then raise exception 'not_signed_in'; end if;
  if p_channel not in ('cardshow','ebay','shopify','in_person','partner','agent') then raise exception 'bad_channel'; end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_listing_ids) x where x is not null;
  if v_ids is null then raise exception 'no_listings'; end if;

  if p_reservation_id is not null then
    select * into v_res from public.listing_reservations where id = p_reservation_id for update;
    if v_res.id is null then return jsonb_build_object('error', 'reservation_not_found'); end if;
    if v_res.status <> 'active' then return jsonb_build_object('error', 'reservation_' || v_res.status); end if;
  end if;

  perform 1 from public.inventory where id = any(v_ids) order by id for update;
  select count(*), array_agg(distinct seller_id),
         array_agg(id) filter (where status = 'Sold' or listing_status = 'sold'
                                  or (p_reservation_id is null and listing_status = 'reserved')
                                  or (p_reservation_id is not null and reservation_id is distinct from p_reservation_id)),
         array_agg(id) filter (where coalesce(to_jsonb(inventory)->>'trust_flag', '') = 'flagged')
    into v_found, v_dealers, v_bad, v_flagged
    from public.inventory where id = any(v_ids);
  if v_found <> cardinality(v_ids) then return jsonb_build_object('error', 'not_found'); end if;
  if not v_service and (cardinality(v_dealers) > 1 or v_dealers[1] <> v_uid) then raise exception 'not_your_listing'; end if;
  if v_bad is not null then return jsonb_build_object('error', 'unavailable', 'unavailable', to_jsonb(v_bad)); end if;
  if v_flagged is not null then return jsonb_build_object('error', 'trust_flag', 'flagged', to_jsonb(v_flagged)); end if;

  perform set_config('cardshow.listing_fn', 'on', true);
  update public.inventory set listing_status = 'sold', status = 'Sold', sold_at = now(), sold_channel = p_channel,
         reserved_until = null, reserved_by = null, reservation_id = null
   where id = any(v_ids);
  perform set_config('cardshow.listing_fn', 'off', true);
  if p_reservation_id is not null then
    update public.listing_reservations set status = 'converted', ended_at = now(), end_reason = 'sold' where id = p_reservation_id;
    -- Cards in the hold that weren't sold go back on sale.
    perform set_config('cardshow.listing_fn', 'on', true);
    update public.inventory set listing_status = 'active', reserved_until = null, reserved_by = null, reservation_id = null
     where reservation_id = p_reservation_id and listing_status = 'reserved';
    perform set_config('cardshow.listing_fn', 'off', true);
  end if;
  perform public._listing_log(v_ids, v_dealers[1], 'sold', case when p_reservation_id is null then 'active' else 'reserved' end, 'sold',
                              p_reservation_id, case when v_service then 'system' else 'dealer' end, coalesce(v_uid::text, 'service'),
                              jsonb_build_object('channel', p_channel));
  return jsonb_build_object('ok', true, 'sold', to_jsonb(v_ids));
end $$;

-- ── Expiry sweep (scheduled, service role only) ───────────────────────────────
create or replace function public.expire_listing_reservations()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  if not public._listing_is_service() and current_user in ('anon','authenticated') then raise exception 'service_only'; end if;
  for r in select id from public.listing_reservations where status = 'active' and expires_at <= now()
            order by expires_at for update skip locked loop
    perform public._release_reservation(r.id, 'expired', 'hold expired', 'system', null);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ── Grants ────────────────────────────────────────────────────────────────────
revoke all on function public._listing_write_allowed() from public;
revoke all on function public._listing_is_service() from public;
grant execute on function public._listing_write_allowed() to anon, authenticated, service_role;
grant execute on function public._listing_is_service() to anon, authenticated, service_role;
revoke all on function public.publish_listings(uuid[]) from public, anon;
revoke all on function public.delist_listings(uuid[]) from public, anon;
revoke all on function public.reserve_listings(uuid[], uuid, text, integer, text) from public, anon;
revoke all on function public.reserve_listing(uuid, uuid, text, integer, text) from public, anon;
revoke all on function public.release_listing(uuid, text) from public, anon;
revoke all on function public.mark_sold(uuid[], text, uuid) from public, anon;
revoke all on function public.expire_listing_reservations() from public, anon, authenticated;
grant execute on function public.publish_listings(uuid[]) to authenticated;
grant execute on function public.delist_listings(uuid[]) to authenticated;
grant execute on function public.reserve_listings(uuid[], uuid, text, integer, text) to authenticated, service_role;
grant execute on function public.reserve_listing(uuid, uuid, text, integer, text) to authenticated, service_role;
grant execute on function public.release_listing(uuid, text) to authenticated, service_role;
grant execute on function public.mark_sold(uuid[], text, uuid) to authenticated, service_role;
grant execute on function public.expire_listing_reservations() to service_role;
grant select on public.listing_reservations, public.listing_events to authenticated, service_role;
grant all on public.listing_reservations, public.listing_events, public.marketplace_settings to service_role;

commit;
