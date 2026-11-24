-- CardShow Marketplace — dealer offer rules (Phase 2). Run after 20261209120000_marketplace_bundle_offers.sql.
-- Re-runnable.
--
-- A dealer sets rules once for all their listings:
--   * decline offers below X% of the asking price, or of the online comp;
--   * counter offers in between at Y% of the asking price;
--   * accept offers at or above Z% of the asking price;
--   * while at a show (joined, running today), don't accept or counter automatically.
-- A card's own lowest-offer and auto-accept prices (Edit Card) win over the rules for that card, and
-- inventory.use_offer_rules = false turns the rules off for one card.
-- The rules run inside the offer functions (make_bundle_offer, and the buyer's counter in _offer_answer).
-- Every automatic decision is added to offers.auto_log and shown to the dealer.
-- Bundles: each card's thresholds are worked out on its own and added up, as before.

begin;

create table if not exists public.dealer_offer_rules (
  dealer_id uuid primary key references auth.users(id) on delete cascade,
  decline_below_pct numeric check (decline_below_pct is null or (decline_below_pct >= 1 and decline_below_pct <= 99)),
  decline_basis text not null default 'asking' check (decline_basis in ('asking','comp')),
  counter_pct numeric check (counter_pct is null or (counter_pct >= 1 and counter_pct <= 99)),
  accept_at_pct numeric check (accept_at_pct is null or (accept_at_pct >= 1 and accept_at_pct <= 99)),
  no_auto_at_show boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.dealer_offer_rules enable row level security;
drop policy if exists dealer_offer_rules_read_own on public.dealer_offer_rules;
create policy dealer_offer_rules_read_own on public.dealer_offer_rules for select to authenticated
  using (dealer_id = auth.uid());
revoke all on public.dealer_offer_rules from anon, authenticated;
grant select on public.dealer_offer_rules to authenticated;

alter table public.inventory add column if not exists use_offer_rules boolean not null default true;
alter table public.offers add column if not exists auto_log jsonb not null default '[]'::jsonb;

-- ── Dealer: save / read the rules ─────────────────────────────────────────────
-- Returns { ok, rules } or { error: not_signed_in | not_a_seller | bad_pct | bad_basis | bad_order }.
create or replace function public.set_offer_rules(p_decline_pct numeric, p_decline_basis text, p_counter_pct numeric,
                                                  p_accept_pct numeric, p_no_auto_at_show boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_basis text := coalesce(nullif(p_decline_basis, ''), 'asking');
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  if not exists (select 1 from public.sellers where id = v_uid) then return jsonb_build_object('error', 'not_a_seller'); end if;
  if v_basis not in ('asking','comp') then return jsonb_build_object('error', 'bad_basis'); end if;
  if (p_decline_pct is not null and (p_decline_pct < 1 or p_decline_pct > 99))
     or (p_counter_pct is not null and (p_counter_pct < 1 or p_counter_pct > 99))
     or (p_accept_pct is not null and (p_accept_pct < 1 or p_accept_pct > 99)) then
    return jsonb_build_object('error', 'bad_pct');
  end if;
  -- Counter sits between the decline line (when it's on the asking price) and the accept line.
  if (p_counter_pct is not null and p_accept_pct is not null and p_counter_pct >= p_accept_pct)
     or (v_basis = 'asking' and p_decline_pct is not null and p_counter_pct is not null and p_counter_pct < p_decline_pct)
     or (v_basis = 'asking' and p_decline_pct is not null and p_accept_pct is not null and p_accept_pct <= p_decline_pct) then
    return jsonb_build_object('error', 'bad_order');
  end if;
  insert into public.dealer_offer_rules (dealer_id, decline_below_pct, decline_basis, counter_pct, accept_at_pct, no_auto_at_show, updated_at)
  values (v_uid, p_decline_pct, v_basis, p_counter_pct, p_accept_pct, coalesce(p_no_auto_at_show, false), now())
  on conflict (dealer_id) do update set decline_below_pct = excluded.decline_below_pct, decline_basis = excluded.decline_basis,
    counter_pct = excluded.counter_pct, accept_at_pct = excluded.accept_at_pct, no_auto_at_show = excluded.no_auto_at_show,
    updated_at = now();
  return jsonb_build_object('ok', true, 'rules',
    (select to_jsonb(r) - 'dealer_id' from public.dealer_offer_rules r where r.dealer_id = v_uid));
end $$;

-- ── Is the dealer at a show right now? (joined, the show runs today in its time zone) ─
create or replace function public._dealer_at_show(p_dealer uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.show_sellers ss join public.shows s on s.id = ss.show_id
     where ss.seller_id = p_dealer and s.start_date is not null
       and (now() at time zone coalesce(nullif(to_jsonb(s)->>'timezone', ''), 'America/Los_Angeles'))::date
           between s.start_date and coalesce(s.end_date, s.start_date)) $$;

-- ── What the cards' settings and the dealer's rules say, added up over the cards ─
create or replace function public._offer_terms(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.dealer_offer_rules; v_dealer uuid; t record;
begin
  select seller_id into v_dealer from public.inventory where id = p_ids[1];
  select * into r from public.dealer_offer_rules where dealer_id = v_dealer;
  select sum(q.price)::bigint as price,
         sum(coalesce(q.min_c, 0))::bigint as min_sum,
         bool_or(q.min_c is not null) as any_min,
         bool_and(q.min_c is null or q.min_rule) as min_all_rule,
         sum(q.auto_c)::bigint as auto_sum,
         bool_and(q.auto_c is not null) as all_auto,
         bool_and(q.auto_c is null or q.auto_rule) as auto_all_rule,
         bool_and(q.rules_on) as all_rules_on
    into t
    from (select i.price_cents as price,
                 (r.dealer_id is not null and i.use_offer_rules) as rules_on,
                 coalesce(i.min_offer_cents,
                          case when r.dealer_id is not null and i.use_offer_rules and r.decline_below_pct is not null then
                            ceil(case r.decline_basis
                                   when 'comp' then case when coalesce(i.comp_value_cents, 0) > 0
                                                          and public._comp_visible(i.pricing_match_status, i.pct_of_comp)
                                                         then i.comp_value_cents end
                                   else i.price_cents end * r.decline_below_pct / 100.0)::integer end) as min_c,
                 i.min_offer_cents is null as min_rule,
                 coalesce(i.auto_accept_cents,
                          case when r.dealer_id is not null and i.use_offer_rules and r.accept_at_pct is not null then
                            ceil(i.price_cents * r.accept_at_pct / 100.0)::integer end) as auto_c,
                 i.auto_accept_cents is null as auto_rule
            from public.inventory i where i.id = any(p_ids)) q;
  return jsonb_build_object(
    'price', t.price, 'min_sum', t.min_sum, 'any_min', coalesce(t.any_min, false), 'min_all_rule', coalesce(t.min_all_rule, false),
    'auto_sum', t.auto_sum, 'all_auto', coalesce(t.all_auto, false), 'auto_all_rule', coalesce(t.auto_all_rule, false),
    'counter_cents', case when r.counter_pct is not null and coalesce(t.all_rules_on, false)
                          then (round(t.price * r.counter_pct / 10000.0) * 100)::integer end,
    'decline_pct', r.decline_below_pct, 'decline_basis', r.decline_basis, 'counter_pct', r.counter_pct,
    'accept_pct', r.accept_at_pct,
    'at_show', coalesce(r.no_auto_at_show, false) and public._dealer_at_show(v_dealer));
end $$;

create or replace function public._offer_log(p_offer uuid, p_entry jsonb) returns void
language sql security definer set search_path = public as $$
  update public.offers set auto_log = auto_log || jsonb_build_array(jsonb_strip_nulls(p_entry || jsonb_build_object('at', now())))
   where id = p_offer $$;

-- ── Answer an offer automatically, or return null to leave it to the dealer. ───
-- p_stage 'new' (a buyer's first offer): accept, decline or counter. 'buyer_counter': accept only.
create or replace function public._offer_auto(p_offer uuid, p_stage text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o public.offers; t jsonb;
  v_price bigint; v_pct integer; v_counter integer; v_auto boolean; v_full boolean;
  v_minutes integer := (public._listing_setting('offer_minutes', '1440'::jsonb))::text::integer;
  v_exp timestamptz;
begin
  select * into o from public.offers where id = p_offer for update;
  t := public._offer_terms(o.listing_ids);
  v_price := (t->>'price')::bigint;
  v_pct := case when v_price > 0 then floor(o.amount_cents * 100.0 / v_price)::integer end;
  v_full := p_stage = 'new' and o.amount_cents >= v_price;
  v_auto := (t->>'all_auto')::boolean and o.amount_cents >= (t->>'auto_sum')::bigint;

  if v_full or v_auto then
    if (t->>'at_show')::boolean then
      perform public._offer_log(o.id, jsonb_build_object('action', 'left_for_you', 'would', 'accept', 'rule', 'at_show',
                                                         'cents', o.amount_cents, 'pct_of_asking', v_pct));
      return null;
    end if;
    perform public._offer_log(o.id, jsonb_build_object('action', 'accept',
      'rule', case when v_full then 'full_price' when (t->>'auto_all_rule')::boolean then 'rule_accept' else 'card_auto' end,
      'cents', o.amount_cents, 'pct_of_asking', v_pct,
      'threshold_cents', case when not v_full then (t->>'auto_sum')::bigint end,
      'rule_pct', case when not v_full and (t->>'auto_all_rule')::boolean then (t->>'accept_pct')::numeric end));
    return public._offer_accept(o.id, 'auto');
  end if;
  if p_stage <> 'new' then return null; end if;

  if (t->>'any_min')::boolean and (t->>'min_sum')::bigint > 0 and o.amount_cents < (t->>'min_sum')::bigint then
    perform public._offer_log(o.id, jsonb_build_object('action', 'decline',
      'rule', case when (t->>'min_all_rule')::boolean then 'rule_decline' else 'card_min' end,
      'cents', o.amount_cents, 'pct_of_asking', v_pct, 'threshold_cents', (t->>'min_sum')::bigint,
      'rule_pct', case when (t->>'min_all_rule')::boolean then (t->>'decline_pct')::numeric end,
      'basis', case when (t->>'min_all_rule')::boolean then t->>'decline_basis' end));
    perform public._offer_end(o.id, 'declined', 'auto', 'below_minimum');
    return jsonb_build_object('ok', true, 'status', 'declined', 'auto', true, 'offer_id', o.id);
  end if;

  -- Never counter above the price the rules would accept anyway.
  v_counter := (t->>'counter_cents')::integer;
  if v_counter is not null and (t->>'all_auto')::boolean then v_counter := least(v_counter, (t->>'auto_sum')::bigint)::integer; end if;
  if v_counter is not null and v_counter > o.amount_cents and v_counter < v_price and o.moves < 3 then
    if (t->>'at_show')::boolean then
      perform public._offer_log(o.id, jsonb_build_object('action', 'left_for_you', 'would', 'counter', 'rule', 'at_show',
                                                         'cents', o.amount_cents, 'counter_cents', v_counter, 'pct_of_asking', v_pct));
      return null;
    end if;
    v_exp := now() + make_interval(mins => v_minutes);
    update public.offers set amount_cents = v_counter, last_by = 'dealer', moves = moves + 1, status = 'countered',
           history = history || jsonb_build_array(jsonb_build_object('by', 'dealer', 'cents', v_counter, 'at', now(), 'auto', true)),
           expires_at = v_exp, updated_at = now()
     where id = o.id;
    perform public._offer_log(o.id, jsonb_build_object('action', 'counter', 'rule', 'rule_counter', 'cents', o.amount_cents,
                                                       'counter_cents', v_counter, 'pct_of_asking', v_pct,
                                                       'rule_pct', (t->>'counter_pct')::numeric));
    perform public._offer_event(o.id, 'countered', 'buyer');
    return jsonb_build_object('ok', true, 'status', 'countered', 'auto', true, 'offer_id', o.id,
                              'amount_cents', v_counter, 'expires_at', v_exp, 'can_counter', true);
  end if;
  return null;
end $$;

-- ── Buyer: offer (as 20261209120000, with the rules) ──────────────────────────
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
  v_r jsonb;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
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
         sum(price_cents)::bigint as price
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

  v_r := public._offer_auto(v_id, 'new');
  if v_r is not null then return v_r; end if;
  perform public._offer_event(v_id, 'new', 'dealer');
  return jsonb_build_object('ok', true, 'status', 'pending', 'offer_id', v_id, 'expires_at', v_exp);
end $$;

-- ── Answer (as 20261209120000; a buyer's counter can be accepted by the rules) ─
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
  v_r jsonb;
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
    if p_side = 'buyer' then
      v_r := public._offer_auto(o.id, 'buyer_counter');
      if v_r is not null then return v_r; end if;
    end if;
    perform public._offer_event(o.id, 'countered', v_other);
    return jsonb_build_object('ok', true, 'status', v_next, 'amount_cents', p_counter);
  end if;
  raise exception 'bad_action';
end $$;

-- ── Lists: the automatic decisions ────────────────────────────────────────────
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
    'auto_log', case when p_for = 'dealer' and jsonb_array_length(o.auto_log) > 0 then o.auto_log end,
    'hold', (select jsonb_build_object('id', r.id, 'status', public._hold_status(r.status, r.expires_at),
                                       'expires_at', r.expires_at, 'end_reason', r.end_reason)
               from public.listing_reservations r where r.id = o.reservation_id)))
$$;

revoke all on function public._dealer_at_show(uuid) from public, anon, authenticated;
revoke all on function public._offer_terms(uuid[]) from public, anon, authenticated;
revoke all on function public._offer_log(uuid, jsonb) from public, anon, authenticated;
revoke all on function public._offer_auto(uuid, text) from public, anon, authenticated;
revoke all on function public.set_offer_rules(numeric, text, numeric, numeric, boolean) from public, anon;
grant execute on function public.set_offer_rules(numeric, text, numeric, numeric, boolean) to authenticated;
revoke all on function public.make_bundle_offer(uuid[], integer, text, text, text) from public, anon;
grant execute on function public.make_bundle_offer(uuid[], integer, text, text, text) to authenticated;

commit;
