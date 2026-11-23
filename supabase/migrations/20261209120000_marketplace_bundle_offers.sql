-- CardShow Marketplace — offers on several cards at once (bundle offers). Run after
-- 20261208120000_marketplace_offers.sql. Re-runnable.
--
-- A buyer picks 2–20 cards from one dealer and offers one price for all of them. Same negotiation as a
-- one-card offer (offer, counter, counter; 24 hours per move). An accepted bundle becomes one hold over
-- all its cards at the agreed total (listing_reservations.listing_ids, agreed_cents); the dealer's
-- "Sold to them" records every card in it.
--
-- * offers.listing_ids holds every card; offers.listing_id stays the first card (one-card offers are
--   unchanged: listing_ids = {listing_id}).
-- * The cards' own settings, added up: auto-accept when the amount reaches the total price, or the sum of
--   every card's auto-accept price (only if every card has one); decline when it's under the sum of the
--   cards' lowest-offer prices.
-- * A buyer can't have two open offers sharing a card (checked in the function; the old one-card unique
--   index is replaced).
-- * A card in the bundle selling, going on hold for someone else or being taken down closes the offer
--   (expire_offers), as for one card.
-- * make_offer(listing, …) is now make_bundle_offer(array[listing], …).

begin;

alter table public.offers add column if not exists listing_ids uuid[];
update public.offers set listing_ids = array[listing_id] where listing_ids is null;
alter table public.offers alter column listing_ids set not null;
alter table public.offers drop constraint if exists offers_listing_ids_check;
alter table public.offers add constraint offers_listing_ids_check
  check (cardinality(listing_ids) between 1 and 20 and listing_ids[1] = listing_id);
drop index if exists public.offers_one_open_idx;
create index if not exists offers_listing_ids_idx on public.offers using gin (listing_ids);

insert into public.marketplace_settings (key, value) values ('max_cards_per_offer', '20'::jsonb)
on conflict (key) do nothing;

-- ── Close open offers that share a card with p_ids (not p_except). ────────────
drop function if exists public._offer_close_card(uuid, uuid, text, uuid);
create or replace function public._offer_close_cards(p_ids uuid[], p_except uuid, p_reason text, p_to_buyer uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in select id, buyer_id from public.offers
            where listing_ids && p_ids and status in ('pending','countered') and id is distinct from p_except
            for update loop
    perform public._offer_end(r.id, 'closed', 'system', p_reason);
    if r.buyer_id is distinct from p_to_buyer then perform public._offer_event(r.id, 'closed', 'buyer'); end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ── Accept: one hold over every card at the agreed amount. ────────────────────
create or replace function public._offer_accept(p_offer uuid, p_by text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o public.offers;
  v_bad integer;
  v_minutes integer := (public._listing_setting('hold_minutes', '1440'::jsonb))::text::integer;
  v_exp timestamptz;
  v_res uuid;
  v_actor text := case p_by when 'dealer' then 'dealer' when 'buyer' then 'buyer' else 'system' end;
  v_actor_id text;
begin
  select * into o from public.offers where id = p_offer for update;
  perform 1 from public.inventory where id = any(o.listing_ids) order by id for update;
  select cardinality(o.listing_ids) - count(*) filter (where i.status <> 'Sold' and i.listing_status = 'active'
                                                         and coalesce(to_jsonb(i)->>'trust_flag', '') not in ('flagged','disputed'))
    into v_bad from public.inventory i where i.id = any(o.listing_ids);
  if v_bad > 0 then
    perform public._offer_end(o.id, 'closed', 'system', 'unavailable');
    if p_by <> 'buyer' then perform public._offer_event(o.id, 'closed', 'buyer'); end if;
    return jsonb_build_object('error', 'unavailable');
  end if;

  v_actor_id := case p_by when 'dealer' then o.dealer_id::text when 'buyer' then o.buyer_id::text else 'auto_accept' end;
  v_exp := now() + make_interval(mins => v_minutes);
  insert into public.listing_reservations (buyer_id, dealer_id, listing_ids, reason, expires_at, actor_type, actor_id,
                                           buyer_name, buyer_contact, buyer_note, agreed_cents, offer_id, placed_notice_at)
  values (o.buyer_id, o.dealer_id, o.listing_ids, 'offer_accepted', v_exp, v_actor, v_actor_id,
          o.buyer_name, o.buyer_contact, o.buyer_note, o.amount_cents, o.id, now())
  returning id into v_res;

  perform set_config('cardshow.listing_fn', 'on', true);
  update public.inventory set listing_status = 'reserved', reserved_until = v_exp, reserved_by = o.buyer_id, reservation_id = v_res
   where id = any(o.listing_ids);
  perform set_config('cardshow.listing_fn', 'off', true);
  perform public._listing_log(o.listing_ids, o.dealer_id, 'reserved', 'active', 'reserved', v_res, v_actor, v_actor_id,
                              jsonb_build_object('reason', 'offer_accepted', 'buyer_id', o.buyer_id, 'offer_id', o.id,
                                                 'agreed_cents', o.amount_cents, 'minutes', v_minutes,
                                                 'cards', cardinality(o.listing_ids)));

  update public.offers set status = 'accepted', decided_by = p_by, reservation_id = v_res, end_reason = 'accepted',
         ended_at = now(), updated_at = now() where id = o.id;
  perform public._offer_event(o.id, 'accepted', case p_by when 'dealer' then 'buyer' else 'dealer' end);
  perform public._offer_close_cards(o.listing_ids, o.id, 'other_offer_accepted', o.buyer_id);
  return jsonb_build_object('ok', true, 'status', 'accepted', 'offer_id', o.id, 'reservation_id', v_res,
                            'hold_expires_at', v_exp, 'agreed_cents', o.amount_cents,
                            'listing_ids', to_jsonb(o.listing_ids));
end $$;

-- ── Buyer: offer on one or several cards from one dealer ──────────────────────
-- Returns { ok, offer_id, status: pending | accepted | declined, ... } or { error: not_signed_in | no_listings |
-- too_many | missing_name | missing_contact | bad_amount | not_found | multiple_dealers | own_listing | unavailable
-- (+ unavailable ids) | no_offers (+ ids) | early_access | above_price | already_open | offer_limit_day }.
create or replace function public.make_bundle_offer(p_listing_ids uuid[], p_amount_cents integer, p_name text,
                                                    p_contact text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_name text := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 60);
  v_contact text := left(btrim(regexp_replace(coalesce(p_contact, ''), '\s+', ' ', 'g')), 120);
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
  v_minutes integer := (public._listing_setting('offer_minutes', '1440'::jsonb))::text::integer;
  v_day_cap integer := (public._listing_setting('max_offers_per_day', '30'::jsonb))::text::integer;
  v_max_cards integer := (public._listing_setting('max_cards_per_offer', '20'::jsonb))::text::integer;
  v_ids uuid[];
  c record;
  v_open uuid;
  v_id uuid;
  v_exp timestamptz;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  -- Distinct, in the order given (the first is the card the offer is filed under).
  select array_agg(x order by o) into v_ids
    from (select x, min(o) as o from unnest(p_listing_ids) with ordinality t(x, o) where x is not null group by x) q;
  if v_ids is null then return jsonb_build_object('error', 'no_listings'); end if;
  if cardinality(v_ids) > v_max_cards then return jsonb_build_object('error', 'too_many', 'limit', v_max_cards); end if;
  if length(v_name) < 1 then return jsonb_build_object('error', 'missing_name'); end if;
  if length(v_contact) < 3 then return jsonb_build_object('error', 'missing_contact'); end if;
  if p_amount_cents is null or p_amount_cents < 100 then return jsonb_build_object('error', 'bad_amount'); end if;

  perform 1 from public.inventory where id = any(v_ids) order by id for update;
  select count(*) as n, array_agg(distinct seller_id) as dealers,
         array_agg(id) filter (where status = 'Sold' or listing_status <> 'active'
                                  or coalesce(to_jsonb(i)->>'trust_flag', '') in ('flagged','disputed')) as bad,
         array_agg(id) filter (where accepts_offers is false or coalesce(price_cents, 0) <= 0) as no_offers,
         bool_or(early_access_until > now()) as early,
         sum(price_cents)::bigint as price,
         sum(coalesce(min_offer_cents, 0))::bigint as min_sum,
         sum(auto_accept_cents)::bigint as auto_sum,
         bool_and(coalesce(auto_accept_cents, 0) > 0) as all_auto
    into c from public.inventory i where id = any(v_ids);
  if c.n <> cardinality(v_ids) then return jsonb_build_object('error', 'not_found'); end if;
  if cardinality(c.dealers) > 1 then return jsonb_build_object('error', 'multiple_dealers'); end if;
  if c.dealers[1] = v_uid then return jsonb_build_object('error', 'own_listing'); end if;
  if c.bad is not null then return jsonb_build_object('error', 'unavailable', 'unavailable', to_jsonb(c.bad)); end if;
  if c.no_offers is not null then return jsonb_build_object('error', 'no_offers', 'no_offers', to_jsonb(c.no_offers)); end if;
  if c.early then return jsonb_build_object('error', 'early_access'); end if;
  if p_amount_cents > c.price then return jsonb_build_object('error', 'above_price', 'price_cents', c.price); end if;

  perform pg_advisory_xact_lock(hashtext('listing_offer:' || v_uid::text));
  for v_open in select id from public.offers
                 where buyer_id = v_uid and status in ('pending','countered') and listing_ids && v_ids loop
    if not public._offer_expire_if_due(v_open) then
      return jsonb_build_object('error', 'already_open', 'offer_id', v_open);
    end if;
  end loop;
  if (select count(*) from public.offers where buyer_id = v_uid and created_at > now() - interval '1 day') >= v_day_cap then
    return jsonb_build_object('error', 'offer_limit_day', 'limit', v_day_cap);
  end if;

  v_exp := now() + make_interval(mins => v_minutes);
  insert into public.offers (listing_id, listing_ids, dealer_id, buyer_id, buyer_name, buyer_contact, buyer_note,
                             amount_cents, offer_cents, asking_cents, last_by, history, expires_at)
  values (v_ids[1], v_ids, c.dealers[1], v_uid, v_name, v_contact, v_note, p_amount_cents, p_amount_cents, c.price,
          'buyer', jsonb_build_array(jsonb_build_object('by', 'buyer', 'cents', p_amount_cents, 'at', now())), v_exp)
  returning id into v_id;

  if p_amount_cents >= c.price or (c.all_auto and p_amount_cents >= c.auto_sum) then
    return public._offer_accept(v_id, 'auto');
  end if;
  if c.min_sum > 0 and p_amount_cents < c.min_sum then
    perform public._offer_end(v_id, 'declined', 'auto', 'below_minimum');
    return jsonb_build_object('ok', true, 'status', 'declined', 'auto', true, 'offer_id', v_id);
  end if;
  perform public._offer_event(v_id, 'new', 'dealer');
  return jsonb_build_object('ok', true, 'status', 'pending', 'offer_id', v_id, 'expires_at', v_exp);
end $$;

create or replace function public.make_offer(p_listing_id uuid, p_amount_cents integer, p_name text, p_contact text,
                                             p_note text default null)
returns jsonb language sql security definer set search_path = public as $$
  select public.make_bundle_offer(array[p_listing_id], p_amount_cents, p_name, p_contact, p_note) $$;

-- ── Answer: the dealer's counter is checked against the bundle's current total. ─
create or replace function public._offer_answer(p_offer uuid, p_side text, p_action text, p_counter integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  o public.offers;
  v_price bigint;
  v_buyer_last integer;
  v_minutes integer := (public._listing_setting('offer_minutes', '1440'::jsonb))::text::integer;
  v_other text := case p_side when 'dealer' then 'buyer' else 'dealer' end;
  v_turn text := case p_side when 'dealer' then 'pending' else 'countered' end;
  v_next text := case p_side when 'dealer' then 'countered' else 'pending' end;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into o from public.offers where id = p_offer for update;
  if o.id is null or (p_side = 'dealer' and o.dealer_id <> v_uid) or (p_side = 'buyer' and o.buyer_id <> v_uid) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if public._offer_expire_if_due(o.id) then return jsonb_build_object('error', 'expired'); end if;
  if o.status <> v_turn then return jsonb_build_object('error', 'not_your_turn', 'status', o.status); end if;

  if p_action = 'accept' then
    return public._offer_accept(o.id, p_side);
  elsif p_action = 'decline' then
    perform public._offer_end(o.id, 'declined', p_side, 'declined');
    perform public._offer_event(o.id, 'declined', v_other);
    return jsonb_build_object('ok', true, 'status', 'declined');
  elsif p_action = 'counter' then
    if o.moves >= 3 then return jsonb_build_object('error', 'no_more_counters'); end if;
    select sum(price_cents) into v_price from public.inventory where id = any(o.listing_ids);
    if p_side = 'dealer' then
      if p_counter is null or p_counter <= o.amount_cents or p_counter >= coalesce(v_price, 0) then
        return jsonb_build_object('error', 'bad_counter', 'min_cents', o.amount_cents + 1, 'max_cents', coalesce(v_price, 0) - 1);
      end if;
    else
      select max((h->>'cents')::integer) into v_buyer_last from jsonb_array_elements(o.history) h where h->>'by' = 'buyer';
      if p_counter is null or p_counter <= coalesce(v_buyer_last, 0) or p_counter >= o.amount_cents then
        return jsonb_build_object('error', 'bad_counter', 'min_cents', coalesce(v_buyer_last, 0) + 1, 'max_cents', o.amount_cents - 1);
      end if;
    end if;
    update public.offers set amount_cents = p_counter, last_by = p_side, moves = moves + 1, status = v_next,
           history = history || jsonb_build_array(jsonb_build_object('by', p_side, 'cents', p_counter, 'at', now())),
           expires_at = now() + make_interval(mins => v_minutes), updated_at = now()
     where id = o.id;
    perform public._offer_event(o.id, 'countered', v_other);
    return jsonb_build_object('ok', true, 'status', v_next, 'amount_cents', p_counter);
  end if;
  raise exception 'bad_action';
end $$;

-- ── Lists ─────────────────────────────────────────────────────────────────────
create or replace function public._offer_json(o public.offers, p_for text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', o.id, 'listing_id', o.listing_id, 'listing_ids', to_jsonb(o.listing_ids),
    'card_count', cardinality(o.listing_ids),
    'status', public._offer_status(o.status, o.expires_at),
    'amount_cents', o.amount_cents, 'offer_cents', o.offer_cents, 'asking_cents', o.asking_cents,
    'last_by', o.last_by, 'moves', o.moves, 'history', o.history,
    'can_counter', o.moves < 3,
    'decided_by', o.decided_by,
    'end_reason', case when o.status in ('pending','countered') and o.expires_at <= now() then 'no_answer' else o.end_reason end,
    'expires_at', o.expires_at, 'created_at', o.created_at, 'updated_at', o.updated_at, 'ended_at', o.ended_at,
    'buyer_name', o.buyer_name, 'buyer_contact', case when p_for = 'dealer' then o.buyer_contact end,
    'buyer_note', o.buyer_note,
    'hold', (select jsonb_build_object('id', r.id, 'status', public._hold_status(r.status, r.expires_at),
                                       'expires_at', r.expires_at, 'end_reason', r.end_reason)
               from public.listing_reservations r where r.id = o.reservation_id)))
$$;

create or replace function public.my_offers()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'status') in ('pending','countered') desc, x->>'updated_at' desc) from (
      select public._offer_json(o, 'buyer')
               || jsonb_build_object('card', public._listing_json(o.listing_id, true),
                                     'cards', (select coalesce(jsonb_agg(public._listing_json(c.id, true) order by c.ord), '[]'::jsonb)
                                                 from unnest(o.listing_ids) with ordinality c(id, ord))) x
        from public.offers o
       where o.buyer_id = v_uid and o.created_at > now() - interval '30 days'
       order by o.updated_at desc limit 100) q), '[]'::jsonb);
end $$;

create or replace function public._offer_dealer_card(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_strip_nulls(jsonb_build_object(
           'id', i.id, 'title', i.card_title, 'stock_code', to_jsonb(i)->>'stock_code', 'price_cents', i.price_cents,
           'comp_value_cents', i.comp_value_cents, 'status', i.status, 'listing_status', i.listing_status))
    from public.inventory i where i.id = p_id $$;

create or replace function public.dealer_offers()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'status') = 'pending' desc, (x->>'status') = 'countered' desc, x->>'updated_at' desc) from (
      select public._offer_json(o, 'dealer')
               || jsonb_build_object('card', public._offer_dealer_card(o.listing_id),
                                     'cards', (select coalesce(jsonb_agg(public._offer_dealer_card(c.id) order by c.ord), '[]'::jsonb)
                                                 from unnest(o.listing_ids) with ordinality c(id, ord))) x
        from public.offers o
       where o.dealer_id = v_uid
         and (o.status in ('pending','countered') or o.ended_at > now() - interval '3 days')
       order by o.updated_at desc limit 200) q), '[]'::jsonb);
end $$;

-- ── Sweep: an offer closes when any of its cards stops being for sale. ─────────
create or replace function public.expire_offers()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; v_status text; n integer := 0;
begin
  if not public._listing_is_service() and current_user in ('anon','authenticated') then raise exception 'service_only'; end if;
  for r in select id from public.offers where status in ('pending','countered') and expires_at <= now()
            for update skip locked loop
    if public._offer_expire_if_due(r.id) then n := n + 1; end if;
  end loop;
  for r in select o.id, o.buyer_id,
                  bool_or(i.status = 'Sold' or i.listing_status = 'sold') as sold,
                  bool_or(i.listing_status = 'reserved') as held,
                  bool_and(coalesce(i.listing_status = 'active' and i.status <> 'Sold', false)
                           or coalesce(i.reserved_by = o.buyer_id, false)) as mine_or_ok
             from public.offers o
             cross join lateral unnest(o.listing_ids) x(id)
             left join public.inventory i on i.id = x.id
            where o.status in ('pending','countered')
            group by o.id, o.buyer_id
           having not bool_and(coalesce(i.listing_status = 'active' and i.status <> 'Sold', false)) loop
    select status into v_status from public.offers where id = r.id for update skip locked;
    if v_status is null or v_status not in ('pending','countered') then continue; end if;
    perform public._offer_end(r.id, 'closed', 'system',
      case when r.sold then 'sold' when r.held then 'held' else 'unavailable' end);
    if not coalesce(r.mine_or_ok, false) then perform public._offer_event(r.id, 'closed', 'buyer'); end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ── Emails: every card in the offer ───────────────────────────────────────────
create or replace function public.offer_notices_due(p_limit integer default 50, p_offer_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public._listing_is_service() and current_user in ('anon','authenticated') then raise exception 'service_only'; end if;
  return coalesce((
    select jsonb_agg(n) from (
      select jsonb_strip_nulls(jsonb_build_object(
               'event_id', e.id, 'offer_id', o.id, 'kind', e.kind, 'to', e.to_whom,
               'email', case e.to_whom when 'dealer' then (select s.email from public.sellers s where s.id = o.dealer_id)
                                       else (select u.email from auth.users u where u.id = o.buyer_id) end,
               'status', o.status, 'decided_by', o.decided_by, 'end_reason', o.end_reason, 'last_by', o.last_by,
               'moves', o.moves, 'amount_cents', o.amount_cents, 'offer_cents', o.offer_cents,
               'asking_cents', o.asking_cents, 'expires_at', o.expires_at,
               'buyer_name', o.buyer_name, 'buyer_contact', o.buyer_contact, 'buyer_note', o.buyer_note,
               'hold_expires_at', (select r.expires_at from public.listing_reservations r where r.id = o.reservation_id),
               'dealer', (select jsonb_strip_nulls(jsonb_build_object('handle', s.handle,
                              'display_name', coalesce(nullif(s.display_name, ''), s.handle)))
                            from public.sellers s where s.id = o.dealer_id),
               'card_count', cardinality(o.listing_ids),
               'cards', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', i.id, 'title', i.card_title,
                            'price_cents', i.price_cents, 'stock_code', to_jsonb(i)->>'stock_code',
                            'url', '/c/' || i.id || '-' || public._listing_slug(i.card_title))) order by c.ord), '[]'::jsonb)
                          from unnest(o.listing_ids) with ordinality c(id, ord) join public.inventory i on i.id = c.id),
               'card', (select jsonb_strip_nulls(jsonb_build_object('id', i.id, 'title', i.card_title,
                            'price_cents', i.price_cents, 'stock_code', to_jsonb(i)->>'stock_code',
                            'url', '/c/' || i.id || '-' || public._listing_slug(i.card_title)))
                          from public.inventory i where i.id = o.listing_id))) n
        from public.offer_events e join public.offers o on o.id = e.offer_id
       where e.sent_at is null and e.created_at > now() - interval '2 days'
         and (p_offer_id is null or o.id = p_offer_id)
       order by e.created_at
       limit greatest(1, least(coalesce(p_limit, 50), 200))) q), '[]'::jsonb);
end $$;

-- ── Grants ────────────────────────────────────────────────────────────────────
revoke all on function public._offer_close_cards(uuid[], uuid, text, uuid) from public, anon, authenticated;
revoke all on function public._offer_dealer_card(uuid) from public, anon, authenticated;
revoke all on function public.make_bundle_offer(uuid[], integer, text, text, text) from public, anon;
revoke all on function public.make_offer(uuid, integer, text, text, text) from public, anon;
grant execute on function public.make_bundle_offer(uuid[], integer, text, text, text) to authenticated;
grant execute on function public.make_offer(uuid, integer, text, text, text) to authenticated;

commit;
