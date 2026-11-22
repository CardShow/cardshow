-- Marketplace search: listings with the dealer's own photo rank first (session 2026-11-22).
-- Run after 20261203120000_marketplace_buyer_site.sql (needs inventory.public_photo_path /
-- public_photo_capture_id). Re-runnable. Replaces search_listings() with the same function plus:
--   * 'best' sort: a listing whose current photo is public (the dealer's own photo, not a catalog image)
--     gets +0.1 on its text rank; with no query every rank is 0, so photos come first, then newest.
--   * With no sort given, the default is now 'best' for every search (was 'newest' without a query).
--     Pass sort 'newest' for strict newest first (saved-search alerts and storefronts already do).

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
    select i.id, i.price_cents, i.pct_of_comp, i.listed_at, i.pickup_show_id,
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
       and (nullif(p->>'comp_min_cents', '') is null or i.comp_value_cents >= (p->>'comp_min_cents')::int)
       and (nullif(p->>'comp_max_cents', '') is null or i.comp_value_cents <= (p->>'comp_max_cents')::int)
       and (not coalesce((p->>'deals_only')::boolean, false) or i.pct_of_comp <= v_deal)
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
