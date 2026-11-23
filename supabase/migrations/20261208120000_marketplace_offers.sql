-- CardShow Marketplace — Make an Offer (Phase 2, step 2). Run after 20261207120000_marketplace_holds.sql.
-- Re-runnable.
--
-- A signed-in buyer offers less than the asking price. The dealer accepts, declines or counters; the buyer
-- answers a counter by accepting, declining or countering once more; the dealer then accepts or declines.
-- At most 3 moves (offer, counter, counter). An offer waits 24 hours for an answer (offer_minutes).
--
-- * An accepted offer becomes a hold for that buyer (listing_reservations, reason 'offer_accepted') at the
--   agreed price (agreed_cents), for hold_minutes (24 h). Same as any hold from there: the buyer pays the
--   dealer when they meet, the dealer records it with "Sold to them" (complete_hold) or releases it, and a
--   table sale to anyone else ends it. Other open offers on that card close.
-- * The dealer's settings on the card apply at once: an offer at or above auto_accept_cents (or the asking
--   price) is accepted; one below min_offer_cents is declined. Cards with accepts_offers = false take none.
-- * Limits: one open offer per buyer per card, 30 offers per buyer per day (max_offers_per_day).
-- * Emails: offer_events rows, sent by netlify/lib/offer-notices.js (offer_notices_due / offer_notice_sent,
--   service role). The hold an accepted offer makes is never announced by the hold emails (placed_notice_at
--   set); its end is, like any hold's.
-- * Holds functions (cancel/release/complete, my_holds, dealer_holds, hold emails) now cover offer holds too.

begin;

-- ── Tables ────────────────────────────────────────────────────────────────────
alter table public.listing_reservations
  add column if not exists agreed_cents integer,
  add column if not exists offer_id uuid;

create table if not exists public.offers (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.inventory(id) on delete cascade,
  dealer_id uuid not null,
  buyer_id uuid not null,
  buyer_name text not null,
  buyer_contact text not null,
  buyer_note text,
  amount_cents integer not null check (amount_cents > 0),     -- the amount on the table now
  offer_cents integer not null check (offer_cents > 0),       -- the buyer's first offer
  asking_cents integer,                                       -- the card's price when the offer was made
  last_by text not null check (last_by in ('buyer','dealer')),
  moves integer not null default 1 check (moves between 1 and 3),
  history jsonb not null default '[]'::jsonb,                 -- [{by, cents, at}]
  status text not null default 'pending'
    check (status in ('pending','countered','accepted','declined','withdrawn','expired','closed')),
  decided_by text check (decided_by in ('buyer','dealer','auto','system')),
  end_reason text,
  reservation_id uuid references public.listing_reservations(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
-- pending = waiting on the dealer, countered = waiting on the buyer.
create unique index if not exists offers_one_open_idx on public.offers (listing_id, buyer_id)
  where status in ('pending','countered');
create index if not exists offers_dealer_idx on public.offers (dealer_id, status);
create index if not exists offers_buyer_idx on public.offers (buyer_id, created_at desc);
create index if not exists offers_open_idx on public.offers (expires_at) where status in ('pending','countered');

create table if not exists public.offer_events (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.offers(id) on delete cascade,
  kind text not null check (kind in ('new','countered','accepted','declined','expired','closed')),
  to_whom text not null check (to_whom in ('buyer','dealer')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists offer_events_due_idx on public.offer_events (created_at) where sent_at is null;

alter table public.offers enable row level security;
alter table public.offer_events enable row level security;
drop policy if exists offers_read_own on public.offers;
create policy offers_read_own on public.offers for select to authenticated
  using (auth.uid() in (buyer_id, dealer_id));
revoke all on public.offers from anon;
revoke insert, update, delete on public.offers from authenticated;
revoke all on public.offer_events from anon, authenticated;
grant select on public.offers to authenticated;
grant all on public.offers, public.offer_events to service_role;

insert into public.marketplace_settings (key, value) values
  ('offer_minutes', '1440'::jsonb),
  ('max_offers_per_day', '30'::jsonb)
on conflict (key) do nothing;

-- ── Helpers ───────────────────────────────────────────────────────────────────
create or replace function public._offer_status(p_status text, p_expires timestamptz) returns text
language sql stable as $$
  select case when p_status in ('pending','countered') and p_expires <= now() then 'expired' else p_status end $$;

create or replace function public._offer_event(p_offer uuid, p_kind text, p_to text) returns void
language sql security definer set search_path = public as $$
  insert into public.offer_events (offer_id, kind, to_whom) values (p_offer, p_kind, p_to) $$;

create or replace function public._offer_end(p_offer uuid, p_status text, p_by text, p_reason text) returns void
language sql security definer set search_path = public as $$
  update public.offers set status = p_status, decided_by = p_by, end_reason = p_reason,
         ended_at = now(), updated_at = now() where id = p_offer $$;

-- Close the open offers on a card (it was held, sold or taken down). The buyer is told unless the card
-- went to them.
create or replace function public._offer_close_card(p_listing uuid, p_except uuid, p_reason text, p_to_buyer uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in select id, buyer_id from public.offers
            where listing_id = p_listing and status in ('pending','countered') and id is distinct from p_except
            for update loop
    perform public._offer_end(r.id, 'closed', 'system', p_reason);
    if r.buyer_id is distinct from p_to_buyer then perform public._offer_event(r.id, 'closed', 'buyer'); end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Accept: the card becomes a hold for the buyer at the agreed amount. p_by: dealer | buyer | auto.
create or replace function public._offer_accept(p_offer uuid, p_by text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o public.offers;
  c record;
  v_minutes integer := (public._listing_setting('hold_minutes', '1440'::jsonb))::text::integer;
  v_exp timestamptz;
  v_res uuid;
  v_actor text := case p_by when 'dealer' then 'dealer' when 'buyer' then 'buyer' else 'system' end;
begin
  select * into o from public.offers where id = p_offer for update;
  select id, seller_id, status, listing_status, coalesce(to_jsonb(i)->>'trust_flag', '') as trust_flag
    into c from public.inventory i where id = o.listing_id for update;
  if c.id is null or c.status = 'Sold' or c.listing_status <> 'active' or c.trust_flag in ('flagged','disputed') then
    perform public._offer_end(o.id, 'closed', 'system', 'unavailable');
    if p_by <> 'buyer' then perform public._offer_event(o.id, 'closed', 'buyer'); end if;
    return jsonb_build_object('error', 'unavailable');
  end if;

  v_exp := now() + make_interval(mins => v_minutes);
  insert into public.listing_reservations (buyer_id, dealer_id, listing_ids, reason, expires_at, actor_type, actor_id,
                                           buyer_name, buyer_contact, buyer_note, agreed_cents, offer_id, placed_notice_at)
  values (o.buyer_id, o.dealer_id, array[o.listing_id], 'offer_accepted', v_exp, v_actor,
          case p_by when 'dealer' then o.dealer_id::text when 'buyer' then o.buyer_id::text else 'auto_accept' end,
          o.buyer_name, o.buyer_contact, o.buyer_note, o.amount_cents, o.id, now())
  returning id into v_res;

  perform set_config('cardshow.listing_fn', 'on', true);
  update public.inventory set listing_status = 'reserved', reserved_until = v_exp, reserved_by = o.buyer_id, reservation_id = v_res
   where id = o.listing_id;
  perform set_config('cardshow.listing_fn', 'off', true);
  perform public._listing_log(array[o.listing_id], o.dealer_id, 'reserved', 'active', 'reserved', v_res, v_actor,
                              case p_by when 'dealer' then o.dealer_id::text when 'buyer' then o.buyer_id::text else 'auto_accept' end,
                              jsonb_build_object('reason', 'offer_accepted', 'buyer_id', o.buyer_id, 'offer_id', o.id,
                                                 'agreed_cents', o.amount_cents, 'minutes', v_minutes));

  update public.offers set status = 'accepted', decided_by = p_by, reservation_id = v_res, end_reason = 'accepted',
         ended_at = now(), updated_at = now() where id = o.id;
  -- Tell the other side (an automatic accept: the dealer; the buyer saw it on screen).
  perform public._offer_event(o.id, 'accepted', case p_by when 'dealer' then 'buyer' else 'dealer' end);
  perform public._offer_close_card(o.listing_id, o.id, 'other_offer_accepted', o.buyer_id);
  return jsonb_build_object('ok', true, 'status', 'accepted', 'offer_id', o.id, 'reservation_id', v_res,
                            'hold_expires_at', v_exp, 'agreed_cents', o.amount_cents);
end $$;

-- An open offer past its time ends as expired (also done by the sweep). Returns true if it had.
create or replace function public._offer_expire_if_due(p_offer uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare o public.offers;
begin
  select * into o from public.offers where id = p_offer;
  if o.status in ('pending','countered') and o.expires_at <= now() then
    perform public._offer_end(o.id, 'expired', 'system', 'no_answer');
    -- The side that made the last move hears that it went unanswered.
    perform public._offer_event(o.id, 'expired', o.last_by);
    return true;
  end if;
  return false;
end $$;

-- ── Buyer: make an offer ──────────────────────────────────────────────────────
-- Returns { ok, offer_id, status: pending | accepted | declined, ... } or { error: not_signed_in | missing_name |
-- missing_contact | bad_amount | not_found | own_listing | unavailable | no_offers | early_access | above_price |
-- already_open | offer_limit_day }.
create or replace function public.make_offer(p_listing_id uuid, p_amount_cents integer, p_name text, p_contact text,
                                             p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_name text := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 60);
  v_contact text := left(btrim(regexp_replace(coalesce(p_contact, ''), '\s+', ' ', 'g')), 120);
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
  v_minutes integer := (public._listing_setting('offer_minutes', '1440'::jsonb))::text::integer;
  v_day_cap integer := (public._listing_setting('max_offers_per_day', '30'::jsonb))::text::integer;
  c record;
  v_open uuid;
  v_id uuid;
  v_exp timestamptz;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  if length(v_name) < 1 then return jsonb_build_object('error', 'missing_name'); end if;
  if length(v_contact) < 3 then return jsonb_build_object('error', 'missing_contact'); end if;
  if p_amount_cents is null or p_amount_cents < 100 then return jsonb_build_object('error', 'bad_amount'); end if;

  select id, seller_id, status, listing_status, price_cents, accepts_offers, min_offer_cents, auto_accept_cents,
         early_access_until, coalesce(to_jsonb(i)->>'trust_flag', '') as trust_flag
    into c from public.inventory i where id = p_listing_id for update;
  if c.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if c.seller_id = v_uid then return jsonb_build_object('error', 'own_listing'); end if;
  if c.status = 'Sold' or c.listing_status <> 'active' or c.trust_flag in ('flagged','disputed') then
    return jsonb_build_object('error', 'unavailable');
  end if;
  if c.accepts_offers is false or coalesce(c.price_cents, 0) <= 0 then return jsonb_build_object('error', 'no_offers'); end if;
  if c.early_access_until > now() then return jsonb_build_object('error', 'early_access'); end if;
  if p_amount_cents > c.price_cents then return jsonb_build_object('error', 'above_price', 'price_cents', c.price_cents); end if;

  select id into v_open from public.offers
   where listing_id = p_listing_id and buyer_id = v_uid and status in ('pending','countered') for update;
  if v_open is not null and public._offer_expire_if_due(v_open) then v_open := null; end if;
  if v_open is not null then return jsonb_build_object('error', 'already_open', 'offer_id', v_open); end if;

  perform pg_advisory_xact_lock(hashtext('listing_offer:' || v_uid::text));
  if (select count(*) from public.offers where buyer_id = v_uid and created_at > now() - interval '1 day') >= v_day_cap then
    return jsonb_build_object('error', 'offer_limit_day', 'limit', v_day_cap);
  end if;

  v_exp := now() + make_interval(mins => v_minutes);
  insert into public.offers (listing_id, dealer_id, buyer_id, buyer_name, buyer_contact, buyer_note,
                             amount_cents, offer_cents, asking_cents, last_by, history, expires_at)
  values (p_listing_id, c.seller_id, v_uid, v_name, v_contact, v_note, p_amount_cents, p_amount_cents, c.price_cents,
          'buyer', jsonb_build_array(jsonb_build_object('by', 'buyer', 'cents', p_amount_cents, 'at', now())), v_exp)
  returning id into v_id;

  -- The dealer's settings on this card answer at once.
  if p_amount_cents >= c.price_cents or (coalesce(c.auto_accept_cents, 0) > 0 and p_amount_cents >= c.auto_accept_cents) then
    return public._offer_accept(v_id, 'auto');
  end if;
  if coalesce(c.min_offer_cents, 0) > 0 and p_amount_cents < c.min_offer_cents then
    perform public._offer_end(v_id, 'declined', 'auto', 'below_minimum');
    return jsonb_build_object('ok', true, 'status', 'declined', 'auto', true, 'offer_id', v_id);
  end if;
  perform public._offer_event(v_id, 'new', 'dealer');
  return jsonb_build_object('ok', true, 'status', 'pending', 'offer_id', v_id, 'expires_at', v_exp);
end $$;

-- ── Answer an offer ───────────────────────────────────────────────────────────
-- Dealer (offer pending): accept | decline | counter (more than the buyer offered, less than the price).
-- Buyer (offer countered): accept | decline | counter (more than their last offer, less than the counter).
create or replace function public._offer_answer(p_offer uuid, p_side text, p_action text, p_counter integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  o public.offers;
  v_price integer;
  v_buyer_last integer;
  v_minutes integer := (public._listing_setting('offer_minutes', '1440'::jsonb))::text::integer;
  v_other text := case p_side when 'dealer' then 'buyer' else 'dealer' end;
  v_turn text := case p_side when 'dealer' then 'pending' else 'countered' end;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into o from public.offers where id = p_offer for update;
  if o.id is null or (p_side = 'dealer' and o.dealer_id <> v_uid) or (p_side = 'buyer' and o.buyer_id <> v_uid) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if public._offer_expire_if_due(o.id) then return jsonb_build_object('error', 'expired'); end if;
  if o.status <> v_turn then
    return jsonb_build_object('error', 'not_your_turn', 'status', o.status);
  end if;

  if p_action = 'accept' then
    return public._offer_accept(o.id, p_side);
  elsif p_action = 'decline' then
    perform public._offer_end(o.id, 'declined', p_side, 'declined');
    perform public._offer_event(o.id, 'declined', v_other);
    return jsonb_build_object('ok', true, 'status', 'declined');
  elsif p_action = 'counter' then
    if o.moves >= 3 then return jsonb_build_object('error', 'no_more_counters'); end if;
    select price_cents into v_price from public.inventory where id = o.listing_id;
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
    update public.offers set amount_cents = p_counter, last_by = p_side, moves = moves + 1,
           status = case p_side when 'dealer' then 'countered' else 'pending' end,
           history = history || jsonb_build_array(jsonb_build_object('by', p_side, 'cents', p_counter, 'at', now())),
           expires_at = now() + make_interval(mins => v_minutes), updated_at = now()
     where id = o.id;
    perform public._offer_event(o.id, 'countered', v_other);
    return jsonb_build_object('ok', true, 'status', case p_side when 'dealer' then 'countered' else 'pending' end,
                              'amount_cents', p_counter);
  end if;
  raise exception 'bad_action';
end $$;

create or replace function public.respond_offer(p_offer_id uuid, p_action text, p_counter_cents integer default null)
returns jsonb language sql security definer set search_path = public as $$
  select public._offer_answer(p_offer_id, 'dealer', p_action, p_counter_cents) $$;

create or replace function public.buyer_respond_offer(p_offer_id uuid, p_action text, p_counter_cents integer default null)
returns jsonb language sql security definer set search_path = public as $$
  select public._offer_answer(p_offer_id, 'buyer', p_action, p_counter_cents) $$;

create or replace function public.withdraw_offer(p_offer_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); o public.offers;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into o from public.offers where id = p_offer_id for update;
  if o.id is null or o.buyer_id <> v_uid then return jsonb_build_object('error', 'not_found'); end if;
  if o.status not in ('pending','countered') then return jsonb_build_object('ok', true, 'already', true, 'status', o.status); end if;
  perform public._offer_end(o.id, 'withdrawn', 'buyer', 'withdrawn');
  return jsonb_build_object('ok', true, 'status', 'withdrawn');
end $$;

-- ── Lists ─────────────────────────────────────────────────────────────────────
create or replace function public._offer_json(o public.offers, p_for text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', o.id, 'listing_id', o.listing_id,
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

-- Buyer: offers from the last 30 days, open ones first. Cards as on the listing page.
create or replace function public.my_offers()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'status') in ('pending','countered') desc, x->>'updated_at' desc) from (
      select public._offer_json(o, 'buyer') || jsonb_build_object('card', public._listing_json(o.listing_id, true)) x
        from public.offers o
       where o.buyer_id = v_uid and o.created_at > now() - interval '30 days'
       order by o.updated_at desc limit 100) q), '[]'::jsonb);
end $$;

-- Dealer: open offers, and offers that ended in the last 3 days.
create or replace function public.dealer_offers()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'status') = 'pending' desc, (x->>'status') = 'countered' desc, x->>'updated_at' desc) from (
      select public._offer_json(o, 'dealer') || jsonb_build_object('card', (select jsonb_strip_nulls(jsonb_build_object(
               'id', i.id, 'title', i.card_title, 'stock_code', to_jsonb(i)->>'stock_code', 'price_cents', i.price_cents,
               'comp_value_cents', i.comp_value_cents, 'status', i.status, 'listing_status', i.listing_status))
               from public.inventory i where i.id = o.listing_id)) x
        from public.offers o
       where o.dealer_id = v_uid
         and (o.status in ('pending','countered') or o.ended_at > now() - interval '3 days')
       order by o.updated_at desc limit 200) q), '[]'::jsonb);
end $$;

-- ── Sweep (service role, every 5 minutes with the hold sweep) ─────────────────
-- Ends unanswered offers, and closes open offers on cards that are no longer for sale.
create or replace function public.expire_offers()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  if not public._listing_is_service() and current_user in ('anon','authenticated') then raise exception 'service_only'; end if;
  for r in select id from public.offers where status in ('pending','countered') and expires_at <= now()
            for update skip locked loop
    if public._offer_expire_if_due(r.id) then n := n + 1; end if;
  end loop;
  for r in select o.id, o.buyer_id, i.reserved_by, i.status as card_status, i.listing_status
             from public.offers o left join public.inventory i on i.id = o.listing_id
            where o.status in ('pending','countered')
              and (i.id is null or i.status = 'Sold' or i.listing_status <> 'active')
            for update of o skip locked loop
    perform public._offer_end(r.id, 'closed', 'system',
      case when r.card_status = 'Sold' or r.listing_status = 'sold' then 'sold' when r.listing_status = 'reserved' then 'held' else 'unavailable' end);
    if r.reserved_by is distinct from r.buyer_id then perform public._offer_event(r.id, 'closed', 'buyer'); end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ── Emails (service role) ─────────────────────────────────────────────────────
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

create or replace function public.offer_notice_sent(p_event_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public._listing_is_service() and current_user in ('anon','authenticated') then raise exception 'service_only'; end if;
  update public.offer_events set sent_at = coalesce(sent_at, now()) where id = p_event_id;
end $$;

create or replace function public.offer_party(p_offer_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.offers where id = p_offer_id and p_user in (buyer_id, dealer_id)) $$;

-- ── Holds now include offer holds (bodies as 20261207120000, reason list widened) ──
create or replace function public.cancel_hold(p_reservation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_res public.listing_reservations;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_res from public.listing_reservations where id = p_reservation_id;
  if v_res.id is null or v_res.buyer_id <> v_uid or v_res.reason not in ('hold','offer_accepted') then return jsonb_build_object('error', 'not_found'); end if;
  return public._release_reservation(p_reservation_id, 'released', 'buyer_cancelled', 'buyer', v_uid::text);
end $$;

create or replace function public.release_hold(p_reservation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_res public.listing_reservations;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_res from public.listing_reservations where id = p_reservation_id;
  if v_res.id is null or v_res.dealer_id <> v_uid or v_res.reason not in ('hold','offer_accepted') then return jsonb_build_object('error', 'not_found'); end if;
  return public._release_reservation(p_reservation_id, 'released', 'dealer_released', 'dealer', v_uid::text);
end $$;

create or replace function public.complete_hold(p_reservation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_res public.listing_reservations; v_ids uuid[];
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_res from public.listing_reservations where id = p_reservation_id for update;
  if v_res.id is null or v_res.dealer_id <> v_uid or v_res.reason not in ('hold','offer_accepted') then return jsonb_build_object('error', 'not_found'); end if;
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
  return jsonb_build_object('ok', true, 'listing_ids', coalesce(to_jsonb(v_ids), '[]'::jsonb), 'agreed_cents', v_res.agreed_cents);
end $$;

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
                 'agreed_cents', r.agreed_cents, 'from_offer', r.reason = 'offer_accepted',
                 'cards', (select coalesce(jsonb_agg(public._listing_json(x, true)), '[]'::jsonb) from unnest(r.listing_ids) x))) h
          from public.listing_reservations r
         where r.buyer_id = v_uid and r.reason in ('hold','offer_accepted') and r.created_at > now() - interval '30 days'
         order by r.created_at desc limit 50) q), '[]'::jsonb);
end $$;

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
                 'agreed_cents', r.agreed_cents, 'from_offer', r.reason = 'offer_accepted',
                 'cards', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                             'id', i.id, 'title', i.card_title, 'stock_code', to_jsonb(i)->>'stock_code',
                             'price_cents', i.price_cents, 'status', i.status, 'listing_status', i.listing_status))), '[]'::jsonb)
                             from public.inventory i where i.id = any(r.listing_ids)))) h
          from public.listing_reservations r
         where r.dealer_id = v_uid and r.reason in ('hold','offer_accepted')
           and (r.status = 'active' or r.ended_at > now() - interval '3 days')
         order by r.created_at desc limit 100) q), '[]'::jsonb);
end $$;

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
               'agreed_cents', r.agreed_cents,
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
       where r.reason in ('hold','offer_accepted') and (p_reservation_id is null or r.id = p_reservation_id)
       order by r.created_at
       limit greatest(1, least(coalesce(p_limit, 50), 200))) q), '[]'::jsonb);
end $$;

create or replace function public.hold_party(p_reservation_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.listing_reservations
                  where id = p_reservation_id and reason in ('hold','offer_accepted') and p_user in (buyer_id, dealer_id))
$$;

-- ── Grants ────────────────────────────────────────────────────────────────────
revoke all on function public._offer_status(text, timestamptz) from public, anon, authenticated;
revoke all on function public._offer_event(uuid, text, text) from public, anon, authenticated;
revoke all on function public._offer_end(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public._offer_close_card(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public._offer_accept(uuid, text) from public, anon, authenticated;
revoke all on function public._offer_expire_if_due(uuid) from public, anon, authenticated;
revoke all on function public._offer_answer(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public._offer_json(public.offers, text) from public, anon, authenticated;
revoke all on function public.make_offer(uuid, integer, text, text, text) from public, anon;
revoke all on function public.respond_offer(uuid, text, integer) from public, anon;
revoke all on function public.buyer_respond_offer(uuid, text, integer) from public, anon;
revoke all on function public.withdraw_offer(uuid) from public, anon;
revoke all on function public.my_offers() from public, anon;
revoke all on function public.dealer_offers() from public, anon;
revoke all on function public.expire_offers() from public, anon, authenticated;
revoke all on function public.offer_notices_due(integer, uuid) from public, anon, authenticated;
revoke all on function public.offer_notice_sent(uuid) from public, anon, authenticated;
revoke all on function public.offer_party(uuid, uuid) from public, anon, authenticated;
grant execute on function public.make_offer(uuid, integer, text, text, text) to authenticated;
grant execute on function public.respond_offer(uuid, text, integer) to authenticated;
grant execute on function public.buyer_respond_offer(uuid, text, integer) to authenticated;
grant execute on function public.withdraw_offer(uuid) to authenticated;
grant execute on function public.my_offers() to authenticated;
grant execute on function public.dealer_offers() to authenticated;
grant execute on function public.expire_offers() to service_role;
grant execute on function public.offer_notices_due(integer, uuid) to service_role;
grant execute on function public.offer_notice_sent(uuid) to service_role;
grant execute on function public.offer_party(uuid, uuid) to service_role;

commit;
