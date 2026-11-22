-- Marketplace pricing: wrong comps stay off the buyer site until checked (session 2026-11-22). Re-runnable.
-- Run after 20261204120000_marketplace_photo_ranking.sql.
--
-- Found on production: a raw 2024 Panini Select C.J. Stroud numbered /49 got the base card's value ($0.69)
-- because its Parallel field only held the serial "17/49". Three safeguards:
-- 1. pricing_match_status 'review' (+ pricing_review_reason): Card Hedge found a card, but CardShow isn't sure it's
--    the same one. Set by the pricing job (netlify/lib/card-values.js) for a numbered or named parallel whose
--    matched title doesn't mention that parallel or print run ('parallel_unconfirmed'). Values are stored but not shown.
-- 2. _comp_visible(status, pct_of_comp): buyers only see an automatic comp between 1/5 and 5 times the asking price.
--    A comp outside that band is hidden (listing page, deal flag, deals filter/sort, comp filters, MCP) and listed
--    in the Pricing tab under "Needs a check". 'manual' (matched or confirmed by the platform owner) always shows.
-- 3. Pricing tab filters "Needs a check" (review + far-off automatic values) and "Matched automatically", and the
--    action 'confirm' (keep the automatic card, show its value). 'retry' now also works on automatic matches.

begin;

alter table public.inventory add column if not exists pricing_review_reason text;
alter table public.inventory drop constraint if exists inventory_pricing_match_status_check;
alter table public.inventory add constraint inventory_pricing_match_status_check
  check (pricing_match_status is null or pricing_match_status in ('matched','no_match','error','manual','ignored','review'));

-- Is this listing's comp shown to buyers? p_pct = price ÷ comp (inventory.pct_of_comp).
create or replace function public._comp_visible(p_status text, p_pct numeric) returns boolean
language sql immutable as $$
  select p_pct is not null and (p_status = 'manual' or (p_status = 'matched' and p_pct between 0.2 and 5))
$$;
grant execute on function public._comp_visible(text, numeric) to anon, authenticated, service_role;

-- The review reason is CardShow's, like the other pricing columns.
create or replace function public._inv_pricing_guard() returns trigger
language plpgsql as $$
begin
  if public._listing_write_allowed() or public._listing_is_service()
     or coalesce(current_setting('cardshow.pricing_fn', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.pricing_card_id is not null or new.pricing_match_status is not null or new.comp_value_cents is not null
       or new.comp_refreshed_at is not null or new.listed_at is not null or new.pricing_matched_at is not null
       or new.pricing_review_reason is not null then
      raise exception 'pricing_locked' using hint = 'Comp values and match ids are set by CardShow, not the app.';
    end if;
  elsif (new.pricing_card_id is distinct from old.pricing_card_id and new.pricing_card_id is not null)
     or (new.pricing_match_status is distinct from old.pricing_match_status and new.pricing_match_status is not null)
     or (new.comp_value_cents is distinct from old.comp_value_cents and new.comp_value_cents is not null)
     or (new.comp_refreshed_at is distinct from old.comp_refreshed_at and new.comp_refreshed_at is not null)
     or (new.pricing_matched_at is distinct from old.pricing_matched_at and new.pricing_matched_at is not null)
     or new.listed_at is distinct from old.listed_at
     or (new.pricing_review_reason is distinct from old.pricing_review_reason and new.pricing_review_reason is not null) then
    raise exception 'pricing_locked' using hint = 'Comp values and match ids are set by CardShow, not the app.';
  end if;
  return new;
end $$;

-- Result of a match call for one identity. p_status: 'matched' | 'review' | 'no_match' | 'error'.
drop function if exists public.pricing_record_match(text, text, text, text, text);
create or replace function public.pricing_record_match(p_identity text, p_status text, p_card_id text default null,
                                                       p_query text default null, p_title text default null,
                                                       p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform public._require_service();
  if p_status not in ('matched','review','no_match','error') then raise exception 'bad_status'; end if;
  perform set_config('cardshow.pricing_fn', 'on', true);
  if p_status in ('matched','review') then
    if coalesce(p_card_id, '') = '' then raise exception 'card_id_required'; end if;
    insert into public.pricing_cards (card_id, query, title, next_refresh_at, requested_at)
    values (p_card_id, p_query, p_title, now(), now())
    on conflict (card_id) do update set query = coalesce(excluded.query, pricing_cards.query),
                                        title = coalesce(excluded.title, pricing_cards.title),
                                        priority = case when pricing_cards.priority = 'dormant' then 'normal' else pricing_cards.priority end;
    update public.inventory set pricing_card_id = p_card_id, pricing_match_status = p_status, pricing_matched_at = now(),
           pricing_match_attempts = pricing_match_attempts + 1,
           pricing_review_reason = case when p_status = 'review' then coalesce(nullif(p_reason, ''), 'unconfirmed') end
     where pricing_identity = p_identity and pricing_match_status is null;
  elsif p_status = 'no_match' then
    update public.inventory set pricing_match_status = 'no_match', pricing_match_attempts = pricing_match_attempts + 1
     where pricing_identity = p_identity and pricing_match_status is null;
  else
    update public.inventory set pricing_match_attempts = pricing_match_attempts + 1,
           pricing_match_status = case when pricing_match_attempts + 1 >= 3 then 'error' end
     where pricing_identity = p_identity and pricing_match_status is null;
  end if;
  get diagnostics v_n = row_count;
  delete from public.pricing_identity_claims where identity = p_identity;
  perform set_config('cardshow.pricing_fn', 'off', true);
  return jsonb_build_object('ok', true, 'listings', v_n);
end $$;
revoke all on function public.pricing_record_match(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.pricing_record_match(text, text, text, text, text, text) to service_role;

-- Summary numbers for the tab: 'priced' = comps buyers see; 'check' = needs a check; 'auto' = matched automatically.
create or replace function public.pricing_admin_summary()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public._pricing_is_admin() then raise exception 'admin_only'; end if;
  select jsonb_build_object(
    'listed', count(*),
    'priced', count(*) filter (where public._comp_visible(pricing_match_status, pct_of_comp)),
    'waiting', count(*) filter (where pricing_match_status is null),
    'no_comp_yet', count(*) filter (where pricing_match_status in ('matched','manual') and comp_value_cents is null),
    'unmatched', count(*) filter (where pricing_match_status in ('no_match','error')),
    'check', count(*) filter (where pricing_match_status = 'review'
                                 or (pricing_match_status = 'matched' and pct_of_comp is not null
                                     and not public._comp_visible(pricing_match_status, pct_of_comp))),
    'auto', count(*) filter (where pricing_match_status = 'matched'),
    'ignored', count(*) filter (where pricing_match_status = 'ignored'),
    'manual', count(*) filter (where pricing_match_status = 'manual'))
    into v
    from public.inventory
   where listing_status in ('active','reserved') and coalesce(item_type, 'card') = 'card';
  return v || jsonb_build_object(
    'cards', (select coalesce(jsonb_object_agg(priority, n), '{}'::jsonb)
                from (select priority, count(*) n from public.pricing_cards group by priority) t),
    'failing_refreshes', (select count(*) from public.pricing_cards where fail_count > 0),
    'last_refresh', (select max(refreshed_at) from public.pricing_cards),
    'usage_today', (select coalesce(jsonb_object_agg(provider, jsonb_build_object('calls', calls, 'uncached', uncached_calls,
                                                                                    'errors', errors, 'alert_sent_at', alert_sent_at)), '{}'::jsonb)
                      from public.pricing_api_usage where day = current_date));
end $$;

-- The queue: one row per card (pricing identity). p_status: 'open' = couldn't match, 'check' = needs a check,
-- 'auto' = matched automatically, 'manual' = matched by hand, 'ignored' = hidden.
-- Rows carry the matched card (card_id, match_title), its value for the listed grade and the asking price.
create or replace function public.pricing_unmatched(p_status text default 'open', p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_status text := coalesce(p_status, 'open');
begin
  if not public._pricing_is_admin() then raise exception 'admin_only'; end if;
  return coalesce((
    select jsonb_agg(row order by (row->>'listings')::int desc, row->>'oldest')
      from (
        select jsonb_strip_nulls(jsonb_build_object(
                 'identity', i.pricing_identity,
                 'status', max(i.pricing_match_status),
                 'reason', coalesce(max(i.pricing_review_reason),
                                    case when bool_or(i.pricing_match_status = 'matched' and i.pct_of_comp is not null
                                                      and not public._comp_visible(i.pricing_match_status, i.pct_of_comp))
                                         then 'value_far_off' end),
                 'listings', count(*),
                 'dealers', count(distinct i.seller_id),
                 'attempts', max(i.pricing_match_attempts),
                 'grades', to_jsonb(array_agg(distinct i.grade_key)),
                 'card_id', max(i.pricing_card_id),
                 'match_title', max(pc.title),
                 'value_cents', max(coalesce(i.comp_value_cents, cv.value_cents)),
                 'price_cents', max(i.price_cents),
                 'oldest', min(coalesce(i.listed_at, i.created_at)),
                 'card', (array_agg(jsonb_build_object('id', i.id, 'title', i.card_title, 'player', i.player, 'year', i.year,
                                                       'set', i.card_set, 'number', i.card_number, 'parallel', i.parallel,
                                                       'category', i.category, 'subcategory', i.subcategory)
                                    order by i.listed_at nulls last))[1])) as row
          from public.inventory i
          left join public.pricing_cards pc on pc.card_id = i.pricing_card_id
          left join public.card_values cv on cv.card_id = i.pricing_card_id and cv.grade = i.grade_key
         where i.listing_status in ('active','reserved') and coalesce(i.pricing_identity, '') <> ''
           and case v_status
                 when 'ignored' then i.pricing_match_status = 'ignored'
                 when 'manual' then i.pricing_match_status = 'manual'
                 when 'auto' then i.pricing_match_status = 'matched'
                 when 'check' then i.pricing_match_status = 'review'
                                   or (i.pricing_match_status = 'matched' and i.pct_of_comp is not null
                                       and not public._comp_visible(i.pricing_match_status, i.pct_of_comp))
                 else i.pricing_match_status in ('no_match','error') end
         group by i.pricing_identity
         order by count(*) desc
         limit least(greatest(coalesce(p_limit, 100), 1), 500)) t), '[]'::jsonb);
end $$;

-- Resolve one card (every listing with that pricing identity): 'match', 'confirm', 'retry', 'ignore'.
create or replace function public.pricing_admin_resolve(p_identity text, p_action text, p_card_id text default null,
                                                        p_query text default null, p_title text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not public._pricing_is_admin() then raise exception 'admin_only'; end if;
  if coalesce(p_identity, '') = '' then raise exception 'identity_required'; end if;
  perform set_config('cardshow.pricing_fn', 'on', true);
  if p_action = 'match' then
    if coalesce(p_card_id, '') = '' then raise exception 'card_id_required'; end if;
    insert into public.pricing_cards (card_id, query, title, next_refresh_at)
    values (p_card_id, nullif(p_query, ''), nullif(p_title, ''), now())
    on conflict (card_id) do update set query = coalesce(excluded.query, pricing_cards.query),
                                        title = coalesce(excluded.title, pricing_cards.title),
                                        fail_count = 0, last_error = null,
                                        priority = case when pricing_cards.priority = 'dormant' then 'normal' else pricing_cards.priority end;
    update public.inventory set pricing_card_id = p_card_id, pricing_match_status = 'manual', pricing_matched_at = now(),
           pricing_review_reason = null,
           comp_value_cents = case when pricing_card_id is distinct from p_card_id then null else comp_value_cents end,
           comp_refreshed_at = case when pricing_card_id is distinct from p_card_id then null else comp_refreshed_at end
     where pricing_identity = p_identity and listing_status <> 'sold';
    -- Fill comps right away from values already stored for this card.
    update public.inventory i set comp_value_cents = cv.value_cents, comp_refreshed_at = cv.refreshed_at
      from public.card_values cv
     where i.pricing_identity = p_identity and i.pricing_card_id = p_card_id and cv.card_id = p_card_id
       and cv.grade = i.grade_key and i.listing_status <> 'sold';
  elsif p_action = 'confirm' then
    -- The automatic match is right: keep its card, show its value (status 'manual' = checked by the platform owner).
    update public.inventory set pricing_match_status = 'manual', pricing_review_reason = null, pricing_matched_at = now()
     where pricing_identity = p_identity and pricing_match_status in ('matched','review') and pricing_card_id is not null
       and listing_status <> 'sold';
    get diagnostics v_n = row_count;
    update public.inventory i set comp_value_cents = cv.value_cents, comp_refreshed_at = cv.refreshed_at
      from public.card_values cv
     where i.pricing_identity = p_identity and cv.card_id = i.pricing_card_id and cv.grade = i.grade_key
       and i.listing_status <> 'sold';
    delete from public.pricing_identity_claims where identity = p_identity;
    perform set_config('cardshow.pricing_fn', 'off', true);
    return jsonb_build_object('ok', true, 'listings', v_n);
  elsif p_action = 'retry' then
    update public.inventory set pricing_match_status = null, pricing_match_attempts = 0, pricing_card_id = null, pricing_review_reason = null,
           pricing_matched_at = null, comp_value_cents = null, comp_refreshed_at = null
     where pricing_identity = p_identity and pricing_match_status in ('no_match','error','ignored','manual','matched','review');
  elsif p_action = 'ignore' then
    update public.inventory set pricing_match_status = 'ignored', pricing_card_id = null, pricing_matched_at = null, pricing_review_reason = null,
           comp_value_cents = null, comp_refreshed_at = null
     where pricing_identity = p_identity and listing_status <> 'sold';
  else
    raise exception 'bad_action';
  end if;
  get diagnostics v_n = row_count;
  delete from public.pricing_identity_claims where identity = p_identity;
  perform set_config('cardshow.pricing_fn', 'off', true);
  return jsonb_build_object('ok', true, 'listings', v_n);
end $$;

-- One listing as the public sees it: as 20261203120000, but the comp, % of comp and deal flag only when
-- _comp_visible() (automatic comps far from the asking price and unconfirmed matches stay hidden).
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
  -- The public copy only counts while it's still the card's current photo.
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

-- Search: as 20261204120000, but deals, deal sort and comp filters only use comps buyers can see.
create or replace function public.search_listings(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_q text := nullif(lower(btrim(p->>'q')), '');
  v_ts tsquery := public._search_tsquery(p->>'q');
  v_words text[] := array(select w from regexp_split_to_table(lower(coalesce(p->>'q', '')), '[^a-z0-9]+') w where w <> '' limit 12);
  v_limit int := least(greatest(coalesce((p->>'limit')::int, 24), 1), 50);
  v_offset int := least(greatest(coalesce((p->>'offset')::int, 0), 0), 5000);
  v_sort text := coalesce(nullif(p->>'sort', ''), 'best');
  v_deal numeric := (public._listing_setting('deal_max_pct', '0.90'::jsonb))::text::numeric;
  v_lat numeric := nullif(p->'near'->>'lat', '')::numeric;
  v_lng numeric := nullif(p->'near'->>'lng', '')::numeric;
  v_miles numeric := least(coalesce(nullif(p->'near'->>'miles', '')::numeric, 25), 500);
  v_from date := nullif(p->>'date_from', '')::date;
  v_to date := nullif(p->>'date_to', '')::date;
  v_state text := nullif(upper(btrim(p->>'state')), '');
  v_show text := nullif(p->>'show_id', '');
  v_dealer uuid;
  v_ids uuid[]; v_miles_arr numeric[]; v_total int; v_rows jsonb;
begin
  if nullif(p->>'dealer', '') is not null then
    select id into v_dealer from public.sellers where lower(handle) = lower(p->>'dealer');
    if v_dealer is null then return jsonb_build_object('total', 0, 'limit', v_limit, 'offset', v_offset, 'results', '[]'::jsonb); end if;
  end if;
  if v_sort not in ('best','price_asc','price_desc','deal','newest','distance') then v_sort := 'best'; end if;

  with cand as (
    select i.id, i.price_cents,
           -- Only a comp buyers can see counts (see _comp_visible).
           case when public._comp_visible(i.pricing_match_status, i.pct_of_comp) then i.pct_of_comp end as pct_of_comp,
           i.listed_at, i.pickup_show_id,
           -- The dealer's own photo, public and current (same test as _listing_json's photo_path).
           (i.public_photo_path is not null and i.public_photo_capture_id = i.primary_capture_id) as has_photo,
           case when v_q is null then 0
                else coalesce(ts_rank(i.search_doc, v_ts), 0) + word_similarity(v_q, i.search_text) end as rank
      from public.inventory i
     where public._listing_is_public(i.status, i.listing_status, i.early_access_until, to_jsonb(i)->>'trust_flag')
       -- Every word must match: as a word prefix, or (4+ letters) close enough to catch a typo.
       and (v_q is null or (v_ts is not null and i.search_doc @@ v_ts)
            or (cardinality(v_words) > 0 and not exists (
                  select 1 from unnest(v_words) w
                   where not (i.search_doc @@ to_tsquery('simple', quote_literal(w) || ':*')
                              -- Typo match. Not the <% operator: its threshold is a setting Supabase
                              -- won't let a function change (permission denied for pg_trgm.*).
                              or (length(w) >= 4 and word_similarity(w, i.search_text) >= 0.45)))))
       and (nullif(p->>'category', '') is null or lower(i.category) = lower(p->>'category'))
       and (nullif(p->>'subcategory', '') is null or lower(i.subcategory) = lower(p->>'subcategory'))
       and (nullif(p->>'player', '') is null or i.player ilike '%' || (p->>'player') || '%')
       and (nullif(p->>'year_min', '') is null or (case when i.year::text ~ '^\d{4}$' then i.year::text::int end) >= (p->>'year_min')::int)
       and (nullif(p->>'year_max', '') is null or (case when i.year::text ~ '^\d{4}$' then i.year::text::int end) <= (p->>'year_max')::int)
       and (nullif(p->>'set', '') is null or i.card_set ilike '%' || (p->>'set') || '%')
       and (nullif(p->>'number', '') is null or lower(btrim(i.card_number, '# ')) = lower(btrim(p->>'number', '# ')))
       and (nullif(p->>'parallel', '') is null or i.parallel ilike '%' || (p->>'parallel') || '%')
       and (nullif(p->>'grader', '') is null or upper(btrim(i.grader)) = upper(btrim(p->>'grader')))
       and (nullif(p->>'grade_min', '') is null or (case when i.grade_key <> 'Raw' then btrim(i.grade::text)::numeric end) >= (p->>'grade_min')::numeric)
       and (nullif(p->>'grade_max', '') is null or (case when i.grade_key <> 'Raw' then btrim(i.grade::text)::numeric end) <= (p->>'grade_max')::numeric)
       and (nullif(p->>'raw', '') is null or (p->>'raw')::boolean = (i.grade_key = 'Raw'))
       and (nullif(p->>'price_min_cents', '') is null or i.price_cents >= (p->>'price_min_cents')::int)
       and (nullif(p->>'price_max_cents', '') is null or i.price_cents <= (p->>'price_max_cents')::int)
       and (nullif(p->>'comp_min_cents', '') is null or (public._comp_visible(i.pricing_match_status, i.pct_of_comp) and i.comp_value_cents >= (p->>'comp_min_cents')::int))
       and (nullif(p->>'comp_max_cents', '') is null or (public._comp_visible(i.pricing_match_status, i.pct_of_comp) and i.comp_value_cents <= (p->>'comp_max_cents')::int))
       and (not coalesce((p->>'deals_only')::boolean, false)
            or (public._comp_visible(i.pricing_match_status, i.pct_of_comp) and i.pct_of_comp <= v_deal))
       and (nullif(p->>'sale_mode', '') is null or (p->>'sale_mode') = any(coalesce(i.sale_modes, '{ship}')))
       and (v_dealer is null or i.seller_id = v_dealer)
       and (nullif(p->>'listed_after', '') is null or i.listed_at > (p->>'listed_after')::timestamptz)
  ), placed as (
    -- Location filters: the card is at a show (its pickup show or a show it's published to)
    -- in the date window, the state, and/or within the distance.
    select c.*,
           (select min(public._miles(v_lat, v_lng, s.latitude, s.longitude))
              from public.shows s
             where (s.id = c.pickup_show_id or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = c.id))
               and coalesce(s.end_date, s.start_date, current_date) >= coalesce(v_from, current_date)
               and (v_to is null or coalesce(s.start_date, s.end_date) <= v_to)
               and (v_state is null or upper(s.state) = v_state)) as miles
      from cand c
     where (v_show is null or c.pickup_show_id = v_show
            or exists (select 1 from public.show_inventory si where si.show_id = v_show and si.card_id = c.id))
       and (v_state is null and v_from is null and v_to is null and v_lat is null or exists (
             select 1 from public.shows s
              where (s.id = c.pickup_show_id or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = c.id))
                and (v_state is null or upper(s.state) = v_state)
                and coalesce(s.end_date, s.start_date, current_date) >= coalesce(v_from, current_date)
                and (v_to is null or coalesce(s.start_date, s.end_date) <= v_to)))
  ), ordered as (
    select id, miles, row_number() over (order by
             -- Best: listings with the dealer's own photo first (catalog images are low resolution).
             -- With a query, a photo is a small boost on the text rank; without one, photos first, then newest.
             case when v_sort = 'best' then -(rank + case when has_photo then 0.1 else 0 end) end,
             case when v_sort = 'price_asc' then price_cents end,
             case when v_sort = 'price_desc' then -price_cents end,
             case when v_sort = 'deal' then coalesce(pct_of_comp, 99) end,
             case when v_sort = 'distance' then coalesce(miles, 99999) end,
             listed_at desc nulls last, id) as ord
      from placed
     where v_lat is null or (miles is not null and miles <= v_miles)
  )
  select count(*)::int,
         coalesce(array_agg(id order by ord) filter (where ord > v_offset and ord <= v_offset + v_limit), '{}'),
         coalesce(array_agg(miles order by ord) filter (where ord > v_offset and ord <= v_offset + v_limit), '{}')
    into v_total, v_ids, v_miles_arr
    from ordered;

  select coalesce(jsonb_agg(public._listing_json(x.id)
                            || case when x.m is not null then jsonb_build_object('miles', round(x.m, 1)) else '{}'::jsonb end
                            order by x.n), '[]'::jsonb)
    into v_rows
    from unnest(v_ids, v_miles_arr) with ordinality as x(id, m, n);

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'results', v_rows);
end $$;

revoke all on function public.pricing_admin_summary(), public.pricing_unmatched(text, int),
                       public.pricing_admin_resolve(text, text, text, text, text) from public, anon;
grant execute on function public.pricing_admin_summary(), public.pricing_unmatched(text, int),
                          public.pricing_admin_resolve(text, text, text, text, text) to authenticated, service_role;

commit;

-- Check (run after): expect true, true.
--   select public._comp_visible('matched', 57.97) = false, public._comp_visible('manual', 57.97) = true;
