-- CardShow Marketplace — holds (Phase 2, step 1). Run after 20261206120000_marketplace_show_pages.sql.
-- Re-runnable.
--
-- A signed-in buyer taps "Hold this card": the dealer sets it aside for 24 hours (setting
-- hold_minutes) and is told by email and in the app. No money changes hands on CardShow: the buyer
-- pays the dealer when they meet (at the show table or as arranged). Either side can end a hold early.
--
-- * Holds are listing_reservations rows with reason 'hold', plus the buyer's name, how to reach them
--   and an optional note (only the dealer and the buyer can read them, as before).
-- * Buyers hold cards only through place_hold() now: reserve_listings()/reserve_listing() are no
--   longer callable by signed-in users (they took any reason and up to 7 days). The service role
--   keeps them for checkout and agents later.
-- * Limits: 10 cards held at once (max_reserved_cards_per_buyer), 20 holds placed per day
--   (max_holds_per_day).
-- * Ending a hold: cancel_hold() (buyer), release_hold() (dealer), complete_hold() (dealer: "sold to
--   the person holding it", so the sale that follows isn't reported to the buyer as sold to someone
--   else), the expiry sweep, or a table sale by anyone else (the sync trigger, 'sold_elsewhere').
-- * Emails: hold_notices_due() / hold_notice_sent() (service role) feed netlify/lib/hold-notices.js.
--   Dealer: a new hold, a buyer cancelling. Buyer: the dealer released it, it expired, it sold.

begin;

-- ── Columns + reason ──────────────────────────────────────────────────────────
alter table public.listing_reservations
  add column if not exists buyer_name text,
  add column if not exists buyer_contact text,
  add column if not exists buyer_note text,
  add column if not exists placed_notice_at timestamptz,
  add column if not exists ended_notice_at timestamptz;

alter table public.listing_reservations drop constraint if exists listing_reservations_reason_check;
alter table public.listing_reservations add constraint listing_reservations_reason_check
  check (reason in ('buy_now','offer_accepted','local_pickup','lot','wholesale','checkout','hold'));

create index if not exists listing_reservations_dealer_idx on public.listing_reservations (dealer_id, status);
create index if not exists listing_reservations_hold_notice_idx on public.listing_reservations (reason, status)
  where reason = 'hold' and (placed_notice_at is null or ended_notice_at is null);

insert into public.marketplace_settings (key, value) values
  ('hold_minutes', '1440'::jsonb),
  ('max_holds_per_day', '20'::jsonb)
on conflict (key) do nothing;

-- ── reserve_listings: as 20261122120000, plus the 'hold' reason ────────────────
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
  if p_reason not in ('buy_now','offer_accepted','local_pickup','lot','wholesale','checkout','hold') then raise exception 'bad_reason'; end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_listing_ids) x where x is not null;
  if v_ids is null then raise exception 'no_listings'; end if;
  if cardinality(v_ids) > 200 then raise exception 'too_many'; end if;
  v_minutes := least(greatest(coalesce(p_hold_minutes, 15), 1), v_max_hold);
  v_actor_type := case when v_service and p_actor is not null then p_actor
                       when v_service then 'system' else 'buyer' end;
  if v_actor_type not in ('buyer','system','buyer_agent','repacker_agent','external_agent','dealer_agent') then
    raise exception 'bad_actor';
  end if;

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

-- Buyers go through place_hold(); the service role keeps the general function.
revoke all on function public.reserve_listings(uuid[], uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.reserve_listing(uuid, uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_listings(uuid[], uuid, text, integer, text) to service_role;
grant execute on function public.reserve_listing(uuid, uuid, text, integer, text) to service_role;

-- ── Buyer: place a hold ───────────────────────────────────────────────────────
-- Returns { ok, reservation_id, expires_at } or { error: not_signed_in | missing_name | missing_contact |
-- unavailable | not_found | own_listing | early_access | reservation_limit | hold_limit_day | already_yours }.
create or replace function public.place_hold(p_listing_id uuid, p_name text, p_contact text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_name text := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 60);
  v_contact text := left(btrim(regexp_replace(coalesce(p_contact, ''), '\s+', ' ', 'g')), 120);
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
  v_minutes integer := (public._listing_setting('hold_minutes', '1440'::jsonb))::text::integer;
  v_day_cap integer := (public._listing_setting('max_holds_per_day', '20'::jsonb))::text::integer;
  v_card record;
  v_r jsonb;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  if length(v_name) < 1 then return jsonb_build_object('error', 'missing_name'); end if;
  if length(v_contact) < 3 then return jsonb_build_object('error', 'missing_contact'); end if;

  select id, seller_id, listing_status, reservation_id, reserved_by, reserved_until
    into v_card from public.inventory where id = p_listing_id;
  if v_card.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if v_card.seller_id = v_uid then return jsonb_build_object('error', 'own_listing'); end if;
  if v_card.listing_status = 'reserved' and v_card.reserved_by = v_uid and v_card.reserved_until > now() then
    return jsonb_build_object('error', 'already_yours', 'reservation_id', v_card.reservation_id, 'expires_at', v_card.reserved_until);
  end if;
  -- A hold that ran out but hasn't been swept yet (the sweep runs every 5 minutes) ends now.
  if v_card.listing_status = 'reserved' and v_card.reserved_until <= now() and v_card.reservation_id is not null then
    perform public._release_reservation(v_card.reservation_id, 'expired', 'hold expired', 'system', null);
  end if;

  perform pg_advisory_xact_lock(hashtext('listing_hold:' || v_uid::text));
  if (select count(*) from public.listing_reservations
       where buyer_id = v_uid and reason = 'hold' and created_at > now() - interval '1 day') >= v_day_cap then
    return jsonb_build_object('error', 'hold_limit_day', 'limit', v_day_cap);
  end if;

  v_r := public.reserve_listings(array[p_listing_id], v_uid, 'hold', v_minutes, null);
  if v_r ? 'error' then return v_r; end if;
  update public.listing_reservations set buyer_name = v_name, buyer_contact = v_contact, buyer_note = v_note
   where id = (v_r->>'reservation_id')::uuid;
  return jsonb_build_object('ok', true, 'reservation_id', v_r->'reservation_id', 'expires_at', v_r->'expires_at');
end $$;

-- ── Buyer: cancel / Dealer: release ───────────────────────────────────────────
create or replace function public.cancel_hold(p_reservation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_res public.listing_reservations;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_res from public.listing_reservations where id = p_reservation_id;
  if v_res.id is null or v_res.buyer_id <> v_uid or v_res.reason <> 'hold' then return jsonb_build_object('error', 'not_found'); end if;
  return public._release_reservation(p_reservation_id, 'released', 'buyer_cancelled', 'buyer', v_uid::text);
end $$;

create or replace function public.release_hold(p_reservation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_res public.listing_reservations;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_res from public.listing_reservations where id = p_reservation_id;
  if v_res.id is null or v_res.dealer_id <> v_uid or v_res.reason <> 'hold' then return jsonb_build_object('error', 'not_found'); end if;
  return public._release_reservation(p_reservation_id, 'released', 'dealer_released', 'dealer', v_uid::text);
end $$;

-- ── Dealer: the person holding it bought it ───────────────────────────────────
-- Ends the hold as 'converted' and puts the cards back to active, so the dealer app's normal sale
-- (Sell Drawer) records it like any other table sale. Called right before that sale.
create or replace function public.complete_hold(p_reservation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_res public.listing_reservations; v_ids uuid[];
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_res from public.listing_reservations where id = p_reservation_id for update;
  if v_res.id is null or v_res.dealer_id <> v_uid or v_res.reason <> 'hold' then return jsonb_build_object('error', 'not_found'); end if;
  if v_res.status <> 'active' then return jsonb_build_object('ok', true, 'already', true, 'status', v_res.status); end if;
  perform set_config('cardshow.listing_fn', 'on', true);
  with u as (
    update public.inventory set listing_status = 'active', reserved_until = null, reserved_by = null, reservation_id = null
     where reservation_id = p_reservation_id and listing_status = 'reserved'
    returning id)
  select array_agg(id) into v_ids from u;
  perform set_config('cardshow.listing_fn', 'off', true);
  update public.listing_reservations set status = 'converted', ended_at = now(), end_reason = 'sold_to_holder'
   where id = p_reservation_id;
  if v_ids is not null then
    perform public._listing_log(v_ids, v_uid, 'hold_completed', 'reserved', 'active', p_reservation_id, 'dealer', v_uid::text, null);
  end if;
  return jsonb_build_object('ok', true, 'listing_ids', coalesce(to_jsonb(v_ids), '[]'::jsonb));
end $$;

-- ── Lists ─────────────────────────────────────────────────────────────────────
-- A hold past its end time counts as expired even before the sweep runs.
create or replace function public._hold_status(p_status text, p_expires timestamptz) returns text
language sql stable as $$ select case when p_status = 'active' and p_expires <= now() then 'expired' else p_status end $$;

-- Buyer: holds from the last 30 days, open ones first. Cards as on the listing page.
create or replace function public.my_holds()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(h order by (h->>'status') = 'active' desc, h->>'created_at' desc)
      from (
        select jsonb_strip_nulls(jsonb_build_object(
                 'id', r.id, 'status', public._hold_status(r.status, r.expires_at),
                 'created_at', r.created_at, 'expires_at', r.expires_at, 'ended_at', r.ended_at,
                 'end_reason', case when r.status = 'active' and r.expires_at <= now() then 'hold expired' else r.end_reason end,
                 'name', r.buyer_name, 'contact', r.buyer_contact, 'note', r.buyer_note,
                 'cards', (select coalesce(jsonb_agg(public._listing_json(x, true)), '[]'::jsonb) from unnest(r.listing_ids) x))) h
          from public.listing_reservations r
         where r.buyer_id = v_uid and r.reason = 'hold' and r.created_at > now() - interval '30 days'
         order by r.created_at desc limit 50) q), '[]'::jsonb);
end $$;

-- Dealer: open holds, and holds that ended in the last 3 days.
create or replace function public.dealer_holds()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(h order by (h->>'status') = 'active' desc, h->>'expires_at')
      from (
        select jsonb_strip_nulls(jsonb_build_object(
                 'id', r.id, 'status', public._hold_status(r.status, r.expires_at),
                 'created_at', r.created_at, 'expires_at', r.expires_at, 'ended_at', r.ended_at,
                 'end_reason', case when r.status = 'active' and r.expires_at <= now() then 'hold expired' else r.end_reason end,
                 'buyer_name', r.buyer_name, 'buyer_contact', r.buyer_contact, 'buyer_note', r.buyer_note,
                 'cards', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                             'id', i.id, 'title', i.card_title, 'stock_code', to_jsonb(i)->>'stock_code',
                             'price_cents', i.price_cents, 'status', i.status, 'listing_status', i.listing_status))), '[]'::jsonb)
                             from public.inventory i where i.id = any(r.listing_ids)))) h
          from public.listing_reservations r
         where r.dealer_id = v_uid and r.reason = 'hold'
           and (r.status = 'active' or r.ended_at > now() - interval '3 days')
         order by r.created_at desc limit 100) q), '[]'::jsonb);
end $$;

-- ── Emails (service role) ─────────────────────────────────────────────────────
-- kind 'placed': to the dealer, for an open hold not yet announced.
-- kind 'ended':  to the buyer (dealer released, expired, sold to someone else), to the dealer (buyer
--                cancelled, only if the dealer heard about the hold), or to nobody (sold to the holder).
create or replace function public.hold_notices_due(p_limit integer default 50, p_reservation_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public._listing_is_service() and current_user in ('anon','authenticated') then raise exception 'service_only'; end if;
  return coalesce((
    select jsonb_agg(n) from (
      select jsonb_strip_nulls(jsonb_build_object(
               'reservation_id', r.id,
               'kind', k.kind,
               'to', k.to_whom,
               'email', case k.to_whom when 'dealer' then (select s.email from public.sellers s where s.id = r.dealer_id)
                                       when 'buyer' then (select u.email from auth.users u where u.id = r.buyer_id) end,
               'end_reason', r.end_reason,
               'status', r.status,
               'expires_at', r.expires_at,
               'buyer_name', r.buyer_name, 'buyer_contact', r.buyer_contact, 'buyer_note', r.buyer_note,
               'dealer', (select jsonb_strip_nulls(jsonb_build_object('handle', s.handle,
                              'display_name', coalesce(nullif(s.display_name, ''), s.handle)))
                            from public.sellers s where s.id = r.dealer_id),
               'cards', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                            'id', i.id, 'title', i.card_title, 'price_cents', i.price_cents,
                            'stock_code', to_jsonb(i)->>'stock_code',
                            'url', '/c/' || i.id || '-' || public._listing_slug(i.card_title)))), '[]'::jsonb)
                          from public.inventory i where i.id = any(r.listing_ids)))) n
        from public.listing_reservations r
        cross join lateral (
          select 'placed'::text as kind, 'dealer'::text as to_whom
           where r.placed_notice_at is null and r.status = 'active' and r.expires_at > now()
          union all
          select 'ended', case
                   when r.end_reason = 'sold_to_holder' then 'none'
                   when r.end_reason = 'buyer_cancelled' then case when r.placed_notice_at is not null then 'dealer' else 'none' end
                   else 'buyer' end
           where r.ended_notice_at is null and r.status in ('released','expired','broken','converted')
             and r.ended_at > now() - interval '2 days') k
       where r.reason = 'hold' and (p_reservation_id is null or r.id = p_reservation_id)
       order by r.created_at
       limit greatest(1, least(coalesce(p_limit, 50), 200))) q), '[]'::jsonb);
end $$;

create or replace function public.hold_notice_sent(p_reservation_id uuid, p_kind text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public._listing_is_service() and current_user in ('anon','authenticated') then raise exception 'service_only'; end if;
  if p_kind = 'placed' then
    update public.listing_reservations set placed_notice_at = coalesce(placed_notice_at, now()) where id = p_reservation_id;
  elsif p_kind = 'ended' then
    update public.listing_reservations set ended_notice_at = coalesce(ended_notice_at, now()) where id = p_reservation_id;
  else raise exception 'bad_kind'; end if;
end $$;

-- Which reservation a signed-in user may ask to be emailed about right away (buyer or dealer of it).
create or replace function public.hold_party(p_reservation_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.listing_reservations
                  where id = p_reservation_id and reason = 'hold' and p_user in (buyer_id, dealer_id))
$$;

-- ── Grants ────────────────────────────────────────────────────────────────────
revoke all on function public.place_hold(uuid, text, text, text) from public, anon;
revoke all on function public.cancel_hold(uuid) from public, anon;
revoke all on function public.release_hold(uuid) from public, anon;
revoke all on function public.complete_hold(uuid) from public, anon;
revoke all on function public.my_holds() from public, anon;
revoke all on function public.dealer_holds() from public, anon;
revoke all on function public.hold_notices_due(integer, uuid) from public, anon, authenticated;
revoke all on function public.hold_notice_sent(uuid, text) from public, anon, authenticated;
revoke all on function public.hold_party(uuid, uuid) from public, anon, authenticated;
grant execute on function public.place_hold(uuid, text, text, text) to authenticated;
grant execute on function public.cancel_hold(uuid) to authenticated;
grant execute on function public.release_hold(uuid) to authenticated;
grant execute on function public.complete_hold(uuid) to authenticated;
grant execute on function public.my_holds() to authenticated;
grant execute on function public.dealer_holds() to authenticated;
grant execute on function public.hold_notices_due(integer, uuid) to service_role;
grant execute on function public.hold_notice_sent(uuid, text) to service_role;
grant execute on function public.hold_party(uuid, uuid) to service_role;

commit;
