-- Marketplace: show pages on the buyer site, pickup show and shipping price per listing (session 2026-11-22).
-- Run after 20261205120000_pricing_review.sql. Re-runnable.
--
-- 1. inventory.shipping_options: { "flat_cents": 500 } (0 = free shipping; no key = "ask the dealer").
-- 2. inventory.pickup_show_id: a dealer can only pick a show they're in (show_sellers). When they leave or are
--    removed from that show, the pickup show is cleared.
-- 3. get_show_page(key): the buyer site's /s/<key> page (key = the show's slug when it has one, else its id):
--    show details and the dealers at it. Its listings come from search_listings({show_id}).
-- 4. _listing_next_show / list_upcoming_shows: show links go to /s/<key> instead of /show.html?id=.
--    _listing_json adds shipping_cents. Both functions are otherwise as in 20261205120000.
begin;

-- ── 1. Shipping price shape ─────────────────────────────────────────────────────
alter table public.inventory drop constraint if exists inventory_shipping_options_check;
alter table public.inventory add constraint inventory_shipping_options_check check (
  shipping_options is null or (
    jsonb_typeof(shipping_options) = 'object'
    and (not (shipping_options ? 'flat_cents') or (
      jsonb_typeof(shipping_options->'flat_cents') = 'number'
      and (shipping_options->>'flat_cents')::numeric between 0 and 100000
      and (shipping_options->>'flat_cents')::numeric = trunc((shipping_options->>'flat_cents')::numeric)))));

-- ── 2. Pickup show ──────────────────────────────────────────────────────────────
-- From the app (anon/authenticated) the pickup show must be one the card's dealer is in.
create or replace function public._inv_pickup_show_check() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.pickup_show_id is null or current_user not in ('anon', 'authenticated') then return new; end if;
  if tg_op = 'UPDATE' and new.pickup_show_id is not distinct from old.pickup_show_id
     and new.seller_id is not distinct from old.seller_id then return new; end if;
  if not exists (select 1 from public.show_sellers ss
                  where ss.show_id = new.pickup_show_id and ss.seller_id = new.seller_id) then
    raise exception 'pickup_show_not_joined' using hint = 'Join the show before picking it as the pickup show.';
  end if;
  return new;
end $$;
drop trigger if exists inv_pickup_show_check on public.inventory;
create trigger inv_pickup_show_check before insert or update on public.inventory
  for each row execute function public._inv_pickup_show_check();

-- A dealer leaving (or removed from) a show: their cards stop saying "pick up at" that show.
create or replace function public._show_sellers_clear_pickup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.inventory set pickup_show_id = null
   where seller_id = old.seller_id and pickup_show_id = old.show_id;
  return old;
end $$;
drop trigger if exists show_sellers_clear_pickup on public.show_sellers;
create trigger show_sellers_clear_pickup after delete on public.show_sellers
  for each row execute function public._show_sellers_clear_pickup();
revoke all on function public._show_sellers_clear_pickup() from public, anon, authenticated;

-- ── 3. Show keys and links ──────────────────────────────────────────────────────
-- The show's key on the buyer site: its slug (set when the platform owner lists it), else its id.
create or replace function public._show_public_key(p_id text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(to_jsonb(s)->>'slug', ''), s.id) from public.shows s where s.id = p_id
$$;
revoke all on function public._show_public_key(text) from public, anon, authenticated;

-- The next show a card will be at (its pickup show, else a show it's published to), today or later.
-- As 20261130120000, plus url (/s/<key>) and pickup (true when it's the dealer's chosen pickup show).
create or replace function public._listing_next_show(p_card uuid, p_pickup text)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(x) from (
    select s.id, s.name, coalesce(s.start_date, null) as start_date, coalesce(s.end_date, s.start_date) as end_date,
           s.city, s.state, s.venue, s.latitude, s.longitude,
           (select ss.table_number from public.show_sellers ss join public.inventory i on i.seller_id = ss.seller_id
             where ss.show_id = s.id and i.id = p_card limit 1) as table_number,
           '/s/' || coalesce(nullif(to_jsonb(s)->>'slug', ''), s.id) as url,
           (s.id = p_pickup) as pickup
      from public.shows s
     where (s.id = p_pickup or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = p_card))
       and coalesce(s.end_date, s.start_date, current_date) >= current_date
     order by (s.id = p_pickup) desc, s.start_date nulls last
     limit 1) x
$$;
revoke all on function public._listing_next_show(uuid, text) from public, anon, authenticated;

-- One listing as the public sees it: as 20261205120000, plus shipping_cents (shipping listings with a price set).
create or replace function public._listing_json(p_id uuid, p_detail boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  i record; j jsonb; s jsonb; v_deal numeric; v_few int; v_graded boolean;
  v_low int; v_high int; v_sales int; v_change numeric; v_source text; v_photo text; v_show_comp boolean;
begin
  select * into i from public.inventory where id = p_id;
  if i is null then return null; end if;
  j := to_jsonb(i);
  v_show_comp := public._comp_visible(i.pricing_match_status, i.pct_of_comp);
  v_graded := i.grade_key <> 'Raw';
  v_deal := (public._listing_setting('deal_max_pct', '0.90'::jsonb))::text::numeric;
  v_few := (public._listing_setting('few_sales_30d', '3'::jsonb))::text::int;
  if i.pricing_card_id is not null then
    select low_cents, high_cents, sales_30d, change_30d_pct, source into v_low, v_high, v_sales, v_change, v_source
      from public.card_values where card_id = i.pricing_card_id and grade = i.grade_key;
  end if;
  select to_jsonb(x) into s from public.sellers x where x.id = i.seller_id;
  v_photo := case when i.public_photo_path is not null and i.public_photo_capture_id = i.primary_capture_id
                  then i.public_photo_path end;
  return jsonb_strip_nulls(jsonb_build_object(
    'id', i.id,
    'url', '/c/' || i.id || '-' || public._listing_slug(i.card_title),
    'title', i.card_title,
    'player', i.player, 'year', i.year, 'set', i.card_set, 'number', i.card_number, 'parallel', i.parallel,
    'grader', case when v_graded then i.grader end,
    'grade', case when v_graded then i.grade end,
    'grade_key', i.grade_key,
    'cert_number', case when v_graded then i.cert_number end,
    'item_type', i.item_type, 'category', i.category, 'subcategory', i.subcategory,
    'listing_status', i.listing_status,
    'price_cents', i.price_cents,
    'comp', case when v_show_comp then jsonb_build_object(
        'value_cents', i.comp_value_cents,
        'low_cents', v_low, 'high_cents', v_high,
        'sales_30d', v_sales, 'change_30d_pct', v_change,
        'few_sales', coalesce(v_sales, 0) < v_few,
        'refreshed_at', i.comp_refreshed_at,
        'source', coalesce(v_source, 'cardhedge')) end,
    'comp_unavailable', not v_show_comp,
    'pct_of_comp', case when v_show_comp then i.pct_of_comp end,
    'deal', v_show_comp and coalesce(i.pct_of_comp <= v_deal, false),
    'accepts_offers', i.accepts_offers,
    'sale_modes', to_jsonb(coalesce(i.sale_modes, '{ship}')),
    'shipping_cents', case when 'ship' = any(coalesce(i.sale_modes, '{ship}')) and i.shipping_options ? 'flat_cents'
                           then (i.shipping_options->>'flat_cents')::int end,
    'gtcr_clear', v_graded and coalesce(j->>'trust_flag', '') = '' and (j->>'trust_clear_at') is not null
                  and (j->>'trust_clear_at')::timestamptz > now() - interval '7 days',
    'image', jsonb_strip_nulls(jsonb_build_object(
        'photo_path', v_photo,
        'stock_image_url', case when nullif(j->>'stock_image_id', '') is not null
                                then '/.netlify/functions/card-image?id=' || (j->>'stock_image_id') end,
        'catalog_image', v_photo is null and nullif(j->>'stock_image_id', '') is not null,
        'has_photo', nullif(j->>'primary_capture_id', '') is not null)),
    'dealer', jsonb_strip_nulls(jsonb_build_object(
        'handle', s->>'handle', 'display_name', coalesce(nullif(s->>'display_name', ''), s->>'handle'),
        'url', '/d/' || coalesce(s->>'handle', ''),
        'whatsapp', case when p_detail then nullif(regexp_replace(coalesce(s->>'whatsapp', ''), '[^0-9]', '', 'g'), '') end,
        'instagram', case when p_detail then nullif(ltrim(coalesce(s->>'instagram', ''), '@ '), '') end)),
    'show', public._listing_next_show(i.id, i.pickup_show_id),
    'listed_at', i.listed_at,
    'features', case when p_detail then j->'features' end,
    'serial_number', case when p_detail then j->>'serial_number' end,
    'print_run_size', case when p_detail then j->'print_run_size' end
  ));
end $$;
revoke all on function public._listing_json(uuid, boolean) from public, anon, authenticated;

-- Upcoming shows: as 20261130120000, with url /s/<key>.
create or replace function public.list_upcoming_shows(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_lat numeric := nullif(p->'near'->>'lat', '')::numeric;
  v_lng numeric := nullif(p->'near'->>'lng', '')::numeric;
  v_miles numeric := least(coalesce(nullif(p->'near'->>'miles', '')::numeric, 50), 1000);
  v_from date := coalesce(nullif(p->>'date_from', '')::date, current_date);
  v_to date := nullif(p->>'date_to', '')::date;
  v_state text := nullif(upper(btrim(p->>'state')), '');
  v_limit int := least(greatest(coalesce((p->>'limit')::int, 20), 1), 50);
begin
  return coalesce((
    select jsonb_agg(row order by row->>'start_date' nulls last, row->>'name')
      from (
        select jsonb_strip_nulls(jsonb_build_object(
                 'id', s.id, 'name', s.name, 'start_date', s.start_date, 'end_date', coalesce(s.end_date, s.start_date),
                 'venue', s.venue, 'city', s.city, 'state', s.state,
                 'miles', round(public._miles(v_lat, v_lng, s.latitude, s.longitude), 1),
                 'listed_cards', (select count(distinct i.id) from public.inventory i
                                   where (i.pickup_show_id = s.id or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = i.id))
                                     and public._listing_is_public(i.status, i.listing_status, i.early_access_until, to_jsonb(i)->>'trust_flag')),
                 'url', '/s/' || coalesce(nullif(to_jsonb(s)->>'slug', ''), s.id))) as row
          from public.shows s
         where coalesce(to_jsonb(s)->>'listed', 'true') <> 'false'
           and nullif(to_jsonb(s)->>'merged_into', '') is null
           and s.start_date is not null
           and coalesce(s.end_date, s.start_date) >= v_from
           and (v_to is null or s.start_date <= v_to)
           and (v_state is null or upper(s.state) = v_state)
           and (v_lat is null or public._miles(v_lat, v_lng, s.latitude, s.longitude) <= v_miles)
         order by s.start_date, s.name
         limit v_limit) t), '[]'::jsonb);
end $$;

-- ── 4. A show's page ────────────────────────────────────────────────────────────
-- p_key: the show's slug or id. Returns the show, or { redirect: '/s/<key>' } when the key isn't the
-- canonical one (an id for a show with a slug, or a show merged into another), or { error: 'not_found' }.
-- Dealers: everyone in show_sellers, with their table number and how many public listings they have here.
create or replace function public.get_show_page(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s record; sj jsonb; v_key text; v_target text; v_dealers jsonb; v_count int;
begin
  if nullif(btrim(coalesce(p_key, '')), '') is null or length(p_key) > 120 then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into s from public.shows x where to_jsonb(x)->>'slug' = p_key limit 1;
  if s is null then select * into s from public.shows where id = p_key; end if;
  if s is null then return jsonb_build_object('error', 'not_found'); end if;
  sj := to_jsonb(s);
  v_target := nullif(sj->>'merged_into', '');
  if v_target is not null and v_target <> s.id and exists (select 1 from public.shows where id = v_target) then
    return jsonb_build_object('redirect', '/s/' || public._show_public_key(v_target));
  end if;
  v_key := coalesce(nullif(sj->>'slug', ''), s.id);
  if v_key <> p_key then return jsonb_build_object('redirect', '/s/' || v_key); end if;

  select coalesce(jsonb_agg(d order by (d->>'listings')::int desc, lower(d->>'display_name')), '[]'::jsonb) into v_dealers
    from (
      select jsonb_strip_nulls(jsonb_build_object(
               'handle', sl.handle,
               'display_name', coalesce(nullif(sl.display_name, ''), sl.handle),
               'table_number', nullif(btrim(coalesce(ss.table_number, '')), ''),
               'url', '/d/' || sl.handle,
               'listings', (select count(*) from public.inventory i
                             where i.seller_id = sl.id
                               and (i.pickup_show_id = s.id or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = i.id))
                               and public._listing_is_public(i.status, i.listing_status, i.early_access_until, to_jsonb(i)->>'trust_flag')))) as d
        from public.show_sellers ss join public.sellers sl on sl.id = ss.seller_id
       where ss.show_id = s.id and sl.handle is not null) t;

  select count(distinct i.id) into v_count from public.inventory i
   where (i.pickup_show_id = s.id or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = i.id))
     and public._listing_is_public(i.status, i.listing_status, i.early_access_until, to_jsonb(i)->>'trust_flag');

  return jsonb_strip_nulls(jsonb_build_object(
    'id', s.id, 'key', v_key, 'url', '/s/' || v_key, 'name', s.name,
    'start_date', s.start_date, 'end_date', coalesce(s.end_date, s.start_date),
    'date_text', case when s.start_date is null then nullif(sj->>'date', '') end,
    'venue', s.venue, 'city', s.city, 'state', s.state,
    'street_address', nullif(sj->>'street_address', ''),
    'website', case when sj->>'website' ~* '^https?://' then sj->>'website' end,
    'listed', coalesce(sj->>'listed', 'true') <> 'false',
    'ended', coalesce(s.end_date, s.start_date) < current_date,
    'latitude', s.latitude, 'longitude', s.longitude,
    'listed_cards', v_count,
    'dealers', v_dealers,
    'show_page', '/show.html?id=' || s.id));
end $$;
revoke all on function public.get_show_page(text) from public;
grant execute on function public.get_show_page(text) to anon, authenticated, service_role;

commit;

-- Check (run after): expect a url starting /s/ for every upcoming listed show.
--   select e->>'url' from jsonb_array_elements(public.list_upcoming_shows()) e;
