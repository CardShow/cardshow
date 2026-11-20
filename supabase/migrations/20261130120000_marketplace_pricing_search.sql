-- CardShow Marketplace, Phase 1 (plan v4): card pricing service, public search, listing pages,
-- saved searches, and the read-only MCP server's data access.
--
-- Run after 20261122120000_marketplace_listings.sql, 20261123120000_marketplace_sold_on_insert.sql,
-- 20261124120000_inventory_rls.sql and 20261129120000_marketplace_listing_photos.sql. Re-runnable.
--
-- What it adds
--   inventory   pricing_card_id (Card Hedge card id), pricing_match_status, grade_key (generated),
--               pricing_identity (generated), comp_refreshed_at, pct_of_comp (generated), listed_at,
--               search_text / search_doc (generated, for search)
--   shows       latitude, longitude (for "within X miles"; filled in later by geocoding)
--   pricing_cards       one row per Card Hedge card: refresh schedule and priority
--   card_values         one row per card and grade (the plan's table)
--   pricing_api_usage   calls per provider per day, plus when the 80% alert went out
--   saved_searches      a buyer's saved searches (own rows only)
--   agent_actions       log of agent / MCP calls (Phase 6 adds mandates)
--   api_rate_limits     fixed-window counters for the MCP server
--
-- Rules
--   * Only the service role writes the pricing columns, card_values and pricing_cards (trigger
--     inv_pricing_a_guard). Sellers can't set their own comp value or "listed" time.
--   * Editing a card's identity (player, year, set, number, parallel, title) clears its match and
--     comp; changing the grade switches the comp to that grade's stored value.
--   * card_values is not readable directly: buyers see values only through search_listings() /
--     get_listing() (keeps the licensed data from being bulk-copied).
--   * Public functions only ever return active, non-early-access, not-flagged listings
--     (get_listing also returns reserved and sold cards, so their pages still open).

begin;

-- ── Extensions ────────────────────────────────────────────────────────────────
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    create extension if not exists pg_trgm with schema extensions;
  else
    create extension if not exists pg_trgm;
  end if;
end $$;

-- ── inventory columns ─────────────────────────────────────────────────────────
alter table public.inventory
  add column if not exists category text,
  add column if not exists subcategory text,
  add column if not exists pricing_card_id text,
  add column if not exists pricing_match_status text,
  add column if not exists pricing_matched_at timestamptz,
  add column if not exists pricing_match_attempts integer not null default 0,
  add column if not exists comp_refreshed_at timestamptz,
  add column if not exists listed_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_pricing_match_status_check') then
    alter table public.inventory add constraint inventory_pricing_match_status_check
      check (pricing_match_status is null or pricing_match_status in ('matched','no_match','error','manual'));
  end if;
end $$;

-- array_to_string is only STABLE, so generated columns use this IMMUTABLE wrapper (text in, text out).
-- p_skip_nulls: drop nulls (search text); otherwise nulls become '' so positions stay fixed (identity).
create or replace function public._imm_join(p_parts text[], p_sep text, p_skip_nulls boolean default false) returns text
language sql immutable parallel safe as $$
  select case when p_skip_nulls then array_to_string(p_parts, p_sep) else array_to_string(p_parts, p_sep, '') end
$$;

-- 'PSA 10', 'BGS 9.5', 'Raw'. Same labels Card Hedge returns. Functions (not inline) because BEFORE
-- triggers see generated columns as null, so the reset trigger calls these directly.
create or replace function public._grade_key(p_grader text, p_grade text) returns text
language sql immutable parallel safe as $$
  select case
    when coalesce(btrim(p_grader), '') <> '' and lower(btrim(p_grader)) <> 'raw'
         and coalesce(p_grade, '') ~ '^\s*\d+(\.\d+)?\s*$'
      then upper(btrim(p_grader)) || ' ' || regexp_replace(regexp_replace(btrim(p_grade), '(\.\d*?)0+$', '\1'), '\.$', '')
    else 'Raw' end
$$;

-- The same card typed the same way by different dealers shares one match call.
create or replace function public._pricing_identity(p_player text, p_year text, p_set text, p_number text, p_parallel text, p_title text)
returns text language sql immutable parallel safe as $$
  select lower(regexp_replace(public._imm_join(array[btrim(p_player), btrim(p_year), btrim(p_set), btrim(p_number), btrim(p_parallel),
                                                    case when coalesce(btrim(p_player), '') = '' then btrim(p_title) end], '|'),
                              '\s+', ' ', 'g'))
$$;

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'grade_key') then
    alter table public.inventory add column grade_key text generated always as (public._grade_key(grader, grade::text)) stored;
  end if;
  -- The same card typed the same way by different dealers shares one match call.
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'pricing_identity') then
    alter table public.inventory add column pricing_identity text generated always as (
      public._pricing_identity(player, year::text, card_set, card_number, parallel, card_title)) stored;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'pct_of_comp') then
    alter table public.inventory add column pct_of_comp numeric generated always as (
      case when comp_value_cents > 0 and price > 0 then round((price * 100) / comp_value_cents, 4) end) stored;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'search_text') then
    alter table public.inventory add column search_text text generated always as (
      lower(public._imm_join(array[card_title, player, year::text, card_set, card_number, parallel, grader, grade::text,
                      category, subcategory], ' ', true))) stored;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'search_doc') then
    alter table public.inventory add column search_doc tsvector generated always as (
      setweight(to_tsvector('simple', coalesce(player, '')), 'A') ||
      setweight(to_tsvector('simple', public._imm_join(array[card_title, card_set, parallel], ' ', true)), 'B') ||
      setweight(to_tsvector('simple', public._imm_join(array[year::text, card_number, grader, grade::text, category, subcategory], ' ', true)), 'C')) stored;
  end if;
end $$;

create index if not exists inventory_search_doc_idx on public.inventory using gin (search_doc);
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'extensions')
     and exists (select 1 from pg_opclass c join pg_namespace n on n.oid = c.opcnamespace where c.opcname = 'gin_trgm_ops' and n.nspname = 'extensions') then
    execute 'create index if not exists inventory_search_trgm_idx on public.inventory using gin (search_text extensions.gin_trgm_ops)';
  else
    execute 'create index if not exists inventory_search_trgm_idx on public.inventory using gin (search_text gin_trgm_ops)';
  end if;
end $$;
create index if not exists inventory_pricing_card_idx on public.inventory (pricing_card_id, grade_key) where pricing_card_id is not null;
create index if not exists inventory_pricing_queue_idx on public.inventory (pricing_identity)
  where pricing_match_status is null and listing_status in ('active','reserved');
create index if not exists inventory_active_listed_idx on public.inventory (listed_at desc) where listing_status = 'active';

-- Cards already listed get a listed time so "newest" sorts sensibly.
update public.inventory set listed_at = coalesce(listed_at, updated_at, created_at, now())
 where listing_status in ('active','reserved') and listed_at is null;

alter table public.shows
  add column if not exists latitude numeric,
  add column if not exists longitude numeric;

-- ── Tables ────────────────────────────────────────────────────────────────────
create table if not exists public.pricing_cards (
  card_id text primary key,                 -- Card Hedge card id
  provider text not null default 'cardhedge',
  query text,                               -- the text used to match it; reused to refresh
  title text,                               -- Card Hedge's description of the card
  priority text not null default 'normal' check (priority in ('high','normal','dormant')),
  value_hint_cents integer,                 -- highest value across grades, for the 3- vs 7-day rule
  active_listings integer not null default 0,
  requested_at timestamptz,                 -- on demand: a listing was viewed with an overdue value
  claimed_until timestamptz,                -- a refresh run is working on it
  refreshed_at timestamptz,
  next_refresh_at timestamptz default now(),
  fail_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists pricing_cards_due_idx on public.pricing_cards (next_refresh_at) where next_refresh_at is not null;
create index if not exists pricing_cards_requested_idx on public.pricing_cards (requested_at) where requested_at is not null;

create table if not exists public.card_values (
  card_id text not null,
  grade text not null,
  value_cents integer,
  low_cents integer,
  high_cents integer,
  sales_30d integer,
  change_30d_pct numeric,
  source text not null default 'cardhedge',
  refreshed_at timestamptz,
  next_refresh_at timestamptz,
  priority text not null default 'normal' check (priority in ('high','normal','dormant')),
  primary key (card_id, grade)
);

create table if not exists public.pricing_api_usage (
  day date not null,
  provider text not null,
  calls integer not null default 0,
  uncached_calls integer not null default 0,
  errors integer not null default 0,
  alert_sent_at timestamptz,
  primary key (day, provider)
);

create table if not exists public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null default 'Saved search',
  params jsonb not null default '{}'::jsonb,
  alerts boolean not null default true,
  last_checked_at timestamptz not null default now(),
  last_alerted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists saved_searches_user_idx on public.saved_searches (user_id);
create index if not exists saved_searches_alert_idx on public.saved_searches (last_checked_at) where alerts;

create table if not exists public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  mandate_id uuid,                          -- Phase 6 adds agent_mandates and the foreign key
  owner_id uuid,
  actor_type text not null check (actor_type in ('buyer_agent','dealer_agent','repacker_agent','external_agent')),
  client text,                              -- MCP client name, e.g. 'claude-ai'
  action text not null,
  tool text,
  target_ids uuid[],
  amount_cents integer,
  reason text,
  detail jsonb,
  approved_by_owner boolean,
  created_at timestamptz not null default now()
);
create index if not exists agent_actions_created_idx on public.agent_actions (created_at);
create index if not exists agent_actions_owner_idx on public.agent_actions (owner_id, created_at) where owner_id is not null;

create table if not exists public.api_rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);

insert into public.marketplace_settings (key, value) values
  ('deal_max_pct', '0.90'::jsonb),            -- deal badge: priced 10%+ under comp
  ('few_sales_30d', '3'::jsonb),              -- fewer sales than this → show the range, "Few recent sales"
  ('pricing_high_value_cents', '25000'::jsonb),
  ('pricing_high_sales_30d', '10'::jsonb)
on conflict (key) do nothing;

-- ── Access ────────────────────────────────────────────────────────────────────
alter table public.pricing_cards enable row level security;
alter table public.card_values enable row level security;
alter table public.pricing_api_usage enable row level security;
alter table public.agent_actions enable row level security;
alter table public.api_rate_limits enable row level security;
alter table public.saved_searches enable row level security;
revoke all on public.pricing_cards, public.card_values, public.pricing_api_usage,
              public.agent_actions, public.api_rate_limits from anon, authenticated;
revoke all on public.saved_searches from anon;
grant select, insert, update, delete on public.saved_searches to authenticated;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'is_cardshow_admin') then
    execute 'drop policy if exists pricing_cards_admin_read on public.pricing_cards';
    execute 'create policy pricing_cards_admin_read on public.pricing_cards for select to authenticated using (public.is_cardshow_admin())';
    execute 'drop policy if exists card_values_admin_read on public.card_values';
    execute 'create policy card_values_admin_read on public.card_values for select to authenticated using (public.is_cardshow_admin())';
    execute 'drop policy if exists pricing_api_usage_admin_read on public.pricing_api_usage';
    execute 'create policy pricing_api_usage_admin_read on public.pricing_api_usage for select to authenticated using (public.is_cardshow_admin())';
    execute 'drop policy if exists agent_actions_admin_read on public.agent_actions';
    execute 'create policy agent_actions_admin_read on public.agent_actions for select to authenticated using (public.is_cardshow_admin())';
    execute 'grant select on public.pricing_cards, public.card_values, public.pricing_api_usage, public.agent_actions to authenticated';
  end if;
end $$;
drop policy if exists agent_actions_owner_read on public.agent_actions;
create policy agent_actions_owner_read on public.agent_actions for select to authenticated using (owner_id = auth.uid());
grant select on public.agent_actions to authenticated;

drop policy if exists saved_searches_own on public.saved_searches;
create policy saved_searches_own on public.saved_searches for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Guard + reset triggers on inventory ───────────────────────────────────────
-- (a) The pricing columns and listed_at come only from the service role or a database function.
create or replace function public._inv_pricing_guard() returns trigger
language plpgsql as $$
begin
  if public._listing_write_allowed() or public._listing_is_service()
     or coalesce(current_setting('cardshow.pricing_fn', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.pricing_card_id is not null or new.pricing_match_status is not null or new.comp_value_cents is not null
       or new.comp_refreshed_at is not null or new.listed_at is not null or new.pricing_matched_at is not null then
      raise exception 'pricing_locked' using hint = 'Comp values and match ids are set by CardShow, not the app.';
    end if;
  elsif (new.pricing_card_id is distinct from old.pricing_card_id and new.pricing_card_id is not null)
     or (new.pricing_match_status is distinct from old.pricing_match_status and new.pricing_match_status is not null)
     or (new.comp_value_cents is distinct from old.comp_value_cents and new.comp_value_cents is not null)
     or (new.comp_refreshed_at is distinct from old.comp_refreshed_at and new.comp_refreshed_at is not null)
     or (new.pricing_matched_at is distinct from old.pricing_matched_at and new.pricing_matched_at is not null)
     or new.listed_at is distinct from old.listed_at then
    raise exception 'pricing_locked' using hint = 'Comp values and match ids are set by CardShow, not the app.';
  end if;
  return new;
end $$;

-- (b) Keeps the comp honest when the card changes, and stamps listed_at when a card goes live.
create or replace function public._inv_pricing_reset() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_val record;
begin
  if tg_op = 'UPDATE' then
    if public._pricing_identity(new.player, new.year::text, new.card_set, new.card_number, new.parallel, new.card_title)
         is distinct from public._pricing_identity(old.player, old.year::text, old.card_set, old.card_number, old.parallel, old.card_title)
       or new.item_type is distinct from old.item_type then
      -- A different card: the old match no longer applies.
      if new.pricing_card_id is not distinct from old.pricing_card_id then
        new.pricing_card_id := null; new.pricing_match_status := null; new.pricing_matched_at := null;
        new.pricing_match_attempts := 0; new.comp_value_cents := null; new.comp_refreshed_at := null;
      end if;
    elsif public._grade_key(new.grader, new.grade::text) is distinct from public._grade_key(old.grader, old.grade::text)
          and new.pricing_card_id is not null
          and new.comp_value_cents is not distinct from old.comp_value_cents then
      -- Same card, different grade: use that grade's stored value (or none yet).
      select value_cents, refreshed_at into v_val from public.card_values
       where card_id = new.pricing_card_id and grade = public._grade_key(new.grader, new.grade::text);
      new.comp_value_cents := v_val.value_cents;
      new.comp_refreshed_at := v_val.refreshed_at;
      if v_val.value_cents is null then
        update public.pricing_cards set requested_at = coalesce(requested_at, now()) where card_id = new.pricing_card_id;
      end if;
    end if;
  end if;
  if new.listing_status = 'active' and (tg_op = 'INSERT' or old.listing_status is distinct from 'active')
     and (tg_op = 'INSERT' or old.listing_status <> 'reserved') then
    new.listed_at := now();
  end if;
  return new;
end $$;

drop trigger if exists inv_pricing_a_guard on public.inventory;
create trigger inv_pricing_a_guard before insert or update on public.inventory
  for each row execute function public._inv_pricing_guard();
drop trigger if exists inv_pricing_b_reset on public.inventory;
create trigger inv_pricing_b_reset before insert or update on public.inventory
  for each row execute function public._inv_pricing_reset();

-- ── Helpers ───────────────────────────────────────────────────────────────────
create or replace function public._require_service() returns void
language plpgsql stable as $$
begin
  if not public._listing_is_service()
     and not (session_user = current_user and current_user not in ('anon','authenticated','service_role','authenticator')) then
    raise exception 'service_role_only';
  end if;
end $$;

create or replace function public._listing_slug(p_title text) returns text
language sql immutable as $$
  select left(trim(both '-' from regexp_replace(lower(coalesce(p_title, 'card')), '[^a-z0-9]+', '-', 'g')), 80)
$$;

-- Prefix query: "charizard psa 10" → 'charizard':* & 'psa':* & '10':*
create or replace function public._search_tsquery(p_q text) returns tsquery
language sql immutable as $$
  select case when count(*) = 0 then null
              else to_tsquery('simple', string_agg(quote_literal(w) || ':*', ' & ')) end
    from (select w from regexp_split_to_table(lower(coalesce(p_q, '')), '[^a-z0-9]+') w where w <> '') t
$$;

-- What anyone may see in search and through the MCP server.
create or replace function public._listing_is_public(p_status text, p_listing_status text, p_early timestamptz, p_trust text)
returns boolean language sql stable as $$
  select p_listing_status = 'active' and coalesce(p_status, '') <> 'Sold'
     and (p_early is null or p_early <= now())
     and coalesce(p_trust, '') not in ('flagged','disputed')
$$;

-- Distance in miles between two points (haversine).
create or replace function public._miles(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric language sql immutable as $$
  select case when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null else
    (3958.8 * 2 * asin(sqrt(power(sin(radians((lat2 - lat1)::float8) / 2), 2)
      + cos(radians(lat1::float8)) * cos(radians(lat2::float8)) * power(sin(radians((lng2 - lng1)::float8) / 2), 2))))::numeric end
$$;

-- The next show a card will be at (its pickup show, else a show it's published to), today or later.
create or replace function public._listing_next_show(p_card uuid, p_pickup text)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(x) from (
    select s.id, s.name, coalesce(s.start_date, null) as start_date, coalesce(s.end_date, s.start_date) as end_date,
           s.city, s.state, s.venue, s.latitude, s.longitude,
           (select ss.table_number from public.show_sellers ss join public.inventory i on i.seller_id = ss.seller_id
             where ss.show_id = s.id and i.id = p_card limit 1) as table_number
      from public.shows s
     where (s.id = p_pickup or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = p_card))
       and coalesce(s.end_date, s.start_date, current_date) >= current_date
     order by (s.id = p_pickup) desc, s.start_date nulls last
     limit 1) x
$$;
revoke all on function public._listing_next_show(uuid, text) from public, anon, authenticated;


-- One listing as the public sees it (no stock code, cost, seller email or private photo keys).
create or replace function public._listing_json(p_id uuid, p_detail boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  i record; j jsonb; s record; v_deal numeric; v_few int; v_graded boolean;
  v_low int; v_high int; v_sales int; v_change numeric; v_source text;
begin
  select * into i from public.inventory where id = p_id;
  if i is null then return null; end if;
  j := to_jsonb(i);
  v_graded := i.grade_key <> 'Raw';
  v_deal := (public._listing_setting('deal_max_pct', '0.90'::jsonb))::text::numeric;
  v_few := (public._listing_setting('few_sales_30d', '3'::jsonb))::text::int;
  if i.pricing_card_id is not null then
    select low_cents, high_cents, sales_30d, change_30d_pct, source into v_low, v_high, v_sales, v_change, v_source
      from public.card_values where card_id = i.pricing_card_id and grade = i.grade_key;
  end if;
  select handle, display_name into s from public.sellers where id = i.seller_id;
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
    'comp', case when i.comp_value_cents is not null then jsonb_build_object(
        'value_cents', i.comp_value_cents,
        'low_cents', v_low, 'high_cents', v_high,
        'sales_30d', v_sales, 'change_30d_pct', v_change,
        'few_sales', coalesce(v_sales, 0) < v_few,
        'refreshed_at', i.comp_refreshed_at,
        'source', coalesce(v_source, 'cardhedge')) end,
    'comp_unavailable', i.comp_value_cents is null,
    'pct_of_comp', i.pct_of_comp,
    'deal', coalesce(i.pct_of_comp <= v_deal, false),
    'accepts_offers', i.accepts_offers,
    'sale_modes', to_jsonb(coalesce(i.sale_modes, '{ship}')),
    'gtcr_clear', v_graded and coalesce(j->>'trust_flag', '') = '' and (j->>'trust_clear_at') is not null
                  and (j->>'trust_clear_at')::timestamptz > now() - interval '7 days',
    'image', jsonb_strip_nulls(jsonb_build_object(
        'stock_image_url', case when nullif(j->>'stock_image_id', '') is not null
                                then '/.netlify/functions/card-image?id=' || (j->>'stock_image_id') end,
        'catalog_image', nullif(j->>'stock_image_id', '') is not null,
        'has_photo', nullif(j->>'primary_capture_id', '') is not null)),
    'dealer', jsonb_build_object('handle', s.handle, 'display_name', coalesce(s.display_name, s.handle),
                                 'url', '/d/' || coalesce(s.handle, '')),
    'show', public._listing_next_show(i.id, i.pickup_show_id),
    'listed_at', i.listed_at,
    'features', case when p_detail then j->'features' end,
    'serial_number', case when p_detail then j->>'serial_number' end,
    'print_run_size', case when p_detail then j->'print_run_size' end
  ));
end $$;
revoke all on function public._listing_json(uuid, boolean) from public, anon, authenticated;

-- ── Public: search ────────────────────────────────────────────────────────────
-- p: { q, category, subcategory, player, year_min, year_max, set, number, parallel, grader,
--      grade_min, grade_max, raw (bool), price_min_cents, price_max_cents, comp_min_cents,
--      comp_max_cents, deals_only, sale_mode ('ship'|'local_pickup'), show_id, state,
--      near: {lat, lng, miles}, date_from, date_to, dealer (handle), listed_after,
--      sort ('best'|'price_asc'|'price_desc'|'deal'|'newest'|'distance'), limit (≤50), offset }
-- Returns { total, limit, offset, results: [listing…] }. Only public listings (see _listing_is_public).
create or replace function public.search_listings(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, extensions
  set pg_trgm.word_similarity_threshold = 0.45 as $$
declare
  v_q text := nullif(lower(btrim(p->>'q')), '');
  v_ts tsquery := public._search_tsquery(p->>'q');
  v_words text[] := array(select w from regexp_split_to_table(lower(coalesce(p->>'q', '')), '[^a-z0-9]+') w where w <> '' limit 12);
  v_limit int := least(greatest(coalesce((p->>'limit')::int, 24), 1), 50);
  v_offset int := least(greatest(coalesce((p->>'offset')::int, 0), 0), 5000);
  v_sort text := coalesce(nullif(p->>'sort', ''), case when nullif(btrim(p->>'q'), '') is null then 'newest' else 'best' end);
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
           case when v_q is null then 0
                else coalesce(ts_rank(i.search_doc, v_ts), 0) + word_similarity(v_q, i.search_text) end as rank
      from public.inventory i
     where public._listing_is_public(i.status, i.listing_status, i.early_access_until, to_jsonb(i)->>'trust_flag')
       -- Every word must match: as a word prefix, or (4+ letters) close enough to catch a typo.
       and (v_q is null or (v_ts is not null and i.search_doc @@ v_ts)
            or (cardinality(v_words) > 0 and not exists (
                  select 1 from unnest(v_words) w
                   where not (i.search_doc @@ to_tsquery('simple', quote_literal(w) || ':*')
                              or (length(w) >= 4 and w <% i.search_text)))))
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
             case when v_sort = 'best' then -rank end,
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

-- ── Public: one listing page ──────────────────────────────────────────────────
-- Active, reserved and sold cards open (so a shared link still works); drafts, delisted,
-- early-access and flagged cards return { error: 'not_found' }.
create or replace function public.get_listing(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare i record;
begin
  select * into i from public.inventory where id = p_id;
  if i is null or i.listing_status not in ('active','reserved','sold')
     or (i.listing_status <> 'sold' and i.early_access_until is not null and i.early_access_until > now())
     or coalesce(to_jsonb(i)->>'trust_flag', '') in ('flagged','disputed') then
    return jsonb_build_object('error', 'not_found');
  end if;
  return public._listing_json(p_id, true);
end $$;

-- ── Public: dealer storefront header ──────────────────────────────────────────
create or replace function public.get_dealer_storefront(p_handle text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s record; v_count int;
begin
  select id, handle, display_name, to_jsonb(sellers.*)->>'instagram' as instagram
    into s from public.sellers where lower(handle) = lower(p_handle);
  if s is null then return jsonb_build_object('error', 'not_found'); end if;
  select count(*) into v_count from public.inventory i
   where i.seller_id = s.id and public._listing_is_public(i.status, i.listing_status, i.early_access_until, to_jsonb(i)->>'trust_flag');
  return jsonb_strip_nulls(jsonb_build_object('handle', s.handle, 'display_name', coalesce(s.display_name, s.handle),
    'instagram', nullif(s.instagram, ''), 'listings', v_count, 'url', '/d/' || s.handle));
end $$;

-- ── Public: upcoming shows ────────────────────────────────────────────────────
-- p: { near: {lat, lng, miles}, state, date_from, date_to, limit (≤50) }
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
                 'url', '/show.html?id=' || s.id)) as row
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

-- ── Public: ask for a fresh value when a listing is viewed ────────────────────
-- Never waits: the page shows the stored value and the refresh job picks this up within minutes.
create or replace function public.request_card_value_refresh(p_listing_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i record; c record;
begin
  select id, pricing_card_id, pricing_match_status, listing_status, comp_refreshed_at into i
    from public.inventory where id = p_listing_id;
  if i is null or i.listing_status not in ('active','reserved') then return jsonb_build_object('ok', false); end if;
  if i.pricing_card_id is null then
    return jsonb_build_object('ok', true, 'status', coalesce(i.pricing_match_status, 'matching'));
  end if;
  select * into c from public.pricing_cards where card_id = i.pricing_card_id;
  if c is null then return jsonb_build_object('ok', true, 'status', 'matching'); end if;
  if c.requested_at is null and (i.comp_refreshed_at is null or c.refreshed_at is null
       or c.next_refresh_at <= now()
       or (c.priority = 'dormant' and c.refreshed_at < now() - interval '7 days')) then
    update public.pricing_cards set requested_at = now() where card_id = c.card_id;
    return jsonb_build_object('ok', true, 'status', 'refreshing');
  end if;
  return jsonb_build_object('ok', true, 'status', case when c.requested_at is not null then 'refreshing' else 'current' end);
end $$;

-- ── Service: pricing job ──────────────────────────────────────────────────────
-- Refresh interval for a card: high daily, normal every 3 days ($50+) or 7 days, dormant only when viewed.
create or replace function public._pricing_interval(p_priority text, p_value_cents integer) returns interval
language sql immutable as $$
  select case p_priority when 'high' then interval '1 day'
                         when 'dormant' then null
                         else case when coalesce(p_value_cents, 0) >= 5000 then interval '3 days' else interval '7 days' end end
$$;

create table if not exists public.pricing_identity_claims (
  identity text primary key,
  claimed_until timestamptz not null
);
alter table public.pricing_identity_claims enable row level security;
revoke all on public.pricing_identity_claims from anon, authenticated;

-- Work for one run: listings to match (one per distinct identity) and cards to refresh.
-- On-demand requests come first, then high priority, then the rest by due time.
create or replace function public.pricing_claim_work(p_match_limit int default 20, p_refresh_limit int default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_match jsonb; v_refresh jsonb;
begin
  perform public._require_service();
  delete from public.pricing_identity_claims where claimed_until < now();

  with q as (
    select i.pricing_identity as identity, min(coalesce(i.listed_at, i.created_at)) as since,
           (array_agg(jsonb_build_object('player', i.player, 'year', i.year, 'set', i.card_set, 'number', i.card_number,
                                         'parallel', i.parallel, 'title', i.card_title, 'category', i.category,
                                         'subcategory', i.subcategory, 'grade_key', i.grade_key)
                      order by i.listed_at nulls last))[1] as sample,
           array_agg(distinct i.grade_key) as grades
      from public.inventory i
     where i.pricing_match_status is null and i.listing_status in ('active','reserved')
       and coalesce(i.item_type, 'card') = 'card' and coalesce(i.pricing_identity, '') <> ''
       and i.pricing_match_attempts < 3
       and not exists (select 1 from public.pricing_identity_claims c where c.identity = i.pricing_identity)
     group by i.pricing_identity
     order by min(coalesce(i.listed_at, i.created_at))
     limit greatest(p_match_limit, 0)
  ), ins as (
    insert into public.pricing_identity_claims (identity, claimed_until)
    select identity, now() + interval '10 minutes' from q
    on conflict (identity) do nothing
    returning identity
  )
  select coalesce(jsonb_agg(jsonb_build_object('identity', q.identity, 'card', q.sample, 'grades', to_jsonb(q.grades))), '[]'::jsonb)
    into v_match from q join ins using (identity);

  with due as (
    select card_id from public.pricing_cards
     where (claimed_until is null or claimed_until < now())
       and (requested_at is not null or (next_refresh_at is not null and next_refresh_at <= now()))
     order by requested_at nulls last, (priority = 'high') desc, next_refresh_at
     limit greatest(p_refresh_limit, 0)
     for update skip locked
  ), upd as (
    update public.pricing_cards pc set claimed_until = now() + interval '10 minutes'
      from due where pc.card_id = due.card_id
    returning pc.card_id, pc.query, pc.title, pc.requested_at is not null as on_demand, pc.priority
  )
  select coalesce(jsonb_agg(to_jsonb(upd) order by on_demand desc), '[]'::jsonb) into v_refresh from upd;

  return jsonb_build_object('match', v_match, 'refresh', v_refresh);
end $$;

-- Result of a match call for one identity. p_status: 'matched' | 'no_match' | 'error'.
create or replace function public.pricing_record_match(p_identity text, p_status text, p_card_id text default null,
                                                       p_query text default null, p_title text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform public._require_service();
  if p_status not in ('matched','no_match','error') then raise exception 'bad_status'; end if;
  perform set_config('cardshow.pricing_fn', 'on', true);
  if p_status = 'matched' then
    if coalesce(p_card_id, '') = '' then raise exception 'card_id_required'; end if;
    insert into public.pricing_cards (card_id, query, title, next_refresh_at, requested_at)
    values (p_card_id, p_query, p_title, now(), now())
    on conflict (card_id) do update set query = coalesce(excluded.query, pricing_cards.query),
                                        title = coalesce(excluded.title, pricing_cards.title),
                                        priority = case when pricing_cards.priority = 'dormant' then 'normal' else pricing_cards.priority end;
    update public.inventory set pricing_card_id = p_card_id, pricing_match_status = 'matched', pricing_matched_at = now(),
           pricing_match_attempts = pricing_match_attempts + 1
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

-- Store one refresh. p_values: [{grade, value_cents, low_cents, high_cents, sales_30d, change_30d_pct}].
-- With p_error set, the stored values stay and the card is retried later (never blanked).
create or replace function public.pricing_apply_values(p_card_id text, p_values jsonb, p_error text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c record; v_max int; v_n int := 0; v_next timestamptz;
begin
  perform public._require_service();
  select * into c from public.pricing_cards where card_id = p_card_id for update;
  if c is null then
    insert into public.pricing_cards (card_id) values (p_card_id) returning * into c;
  end if;

  if p_error is not null or p_values is null or jsonb_typeof(p_values) <> 'array' or jsonb_array_length(p_values) = 0 then
    update public.pricing_cards
       set fail_count = fail_count + 1, last_error = left(coalesce(p_error, 'no_values'), 300), claimed_until = null,
           requested_at = null,
           next_refresh_at = now() + least(interval '1 hour' * power(2, least(fail_count, 5)), interval '1 day')
     where card_id = p_card_id;
    return jsonb_build_object('ok', true, 'stored', 0, 'error', coalesce(p_error, 'no_values'));
  end if;

  select max((x->>'value_cents')::int) into v_max from jsonb_array_elements(p_values) x
   where nullif(x->>'value_cents', '') is not null;
  v_next := now() + coalesce(public._pricing_interval(c.priority, coalesce(v_max, c.value_hint_cents)), interval '3650 days');

  insert into public.card_values (card_id, grade, value_cents, low_cents, high_cents, sales_30d, change_30d_pct,
                                  source, refreshed_at, next_refresh_at, priority)
  select p_card_id, btrim(x->>'grade'), (x->>'value_cents')::int, nullif(x->>'low_cents', '')::int, nullif(x->>'high_cents', '')::int,
         nullif(x->>'sales_30d', '')::int, nullif(x->>'change_30d_pct', '')::numeric,
         coalesce(nullif(x->>'source', ''), 'cardhedge'), now(),
         case when c.priority = 'dormant' then null else v_next end, c.priority
    from jsonb_array_elements(p_values) x
   where coalesce(btrim(x->>'grade'), '') <> '' and (x->>'value_cents')::int > 0
  on conflict (card_id, grade) do update set
    value_cents = excluded.value_cents, low_cents = excluded.low_cents, high_cents = excluded.high_cents,
    sales_30d = excluded.sales_30d, change_30d_pct = excluded.change_30d_pct, source = excluded.source,
    refreshed_at = excluded.refreshed_at, next_refresh_at = excluded.next_refresh_at, priority = excluded.priority;
  get diagnostics v_n = row_count;

  update public.pricing_cards
     set refreshed_at = now(), fail_count = 0, last_error = null, claimed_until = null, requested_at = null,
         value_hint_cents = coalesce(v_max, value_hint_cents),
         next_refresh_at = case when priority = 'dormant' then null else v_next end
   where card_id = p_card_id;

  -- Copy onto the listings so search stays fast.
  perform set_config('cardshow.pricing_fn', 'on', true);
  update public.inventory i set comp_value_cents = cv.value_cents, comp_refreshed_at = cv.refreshed_at
    from public.card_values cv
   where i.pricing_card_id = p_card_id and cv.card_id = p_card_id and cv.grade = i.grade_key
     and i.listing_status <> 'sold'
     and (i.comp_value_cents is distinct from cv.value_cents or i.comp_refreshed_at is distinct from cv.refreshed_at);
  perform set_config('cardshow.pricing_fn', 'off', true);
  return jsonb_build_object('ok', true, 'stored', v_n);
end $$;

-- Count provider calls. Returns the day's totals.
create or replace function public.pricing_bump_usage(p_provider text, p_calls int default 1, p_uncached int default 0, p_errors int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  perform public._require_service();
  insert into public.pricing_api_usage (day, provider, calls, uncached_calls, errors)
  values (current_date, p_provider, greatest(p_calls, 0), greatest(p_uncached, 0), greatest(p_errors, 0))
  on conflict (day, provider) do update set calls = pricing_api_usage.calls + excluded.calls,
    uncached_calls = pricing_api_usage.uncached_calls + excluded.uncached_calls,
    errors = pricing_api_usage.errors + excluded.errors
  returning * into r;
  return to_jsonb(r);
end $$;

-- Marks the day's 80% alert as sent. True only the first time (so one email per day per provider).
create or replace function public.pricing_mark_alert(p_provider text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform public._require_service();
  update public.pricing_api_usage set alert_sent_at = now()
   where day = current_date and provider = p_provider and alert_sent_at is null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

-- Nightly: count active listings per card and set its priority.
-- High: at an upcoming show in the next 7 days (Show Drop window), worth $250+, or 10+ sales in 30 days.
-- (Open offers, open lots and buy orders join this rule in Phases 2–3.)
create or replace function public.pricing_recalc_priorities()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hi_val int := (public._listing_setting('pricing_high_value_cents', '25000'::jsonb))::text::int;
  v_hi_sales int := (public._listing_setting('pricing_high_sales_30d', '10'::jsonb))::text::int;
  v_counts jsonb;
begin
  perform public._require_service();
  with stats as (
    select pc.card_id,
           (select count(*) from public.inventory i where i.pricing_card_id = pc.card_id and i.listing_status in ('active','reserved')) as n,
           exists (select 1 from public.inventory i
                     join public.shows s on s.id = i.pickup_show_id
                       or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = i.id)
                    where i.pricing_card_id = pc.card_id and i.listing_status in ('active','reserved')
                      and s.start_date between current_date - 3 and current_date + 7) as at_show,
           (select max(sales_30d) from public.card_values cv where cv.card_id = pc.card_id) as sales
      from public.pricing_cards pc
  ), pr as (
    select card_id, n, case when n = 0 then 'dormant'
                            when at_show or coalesce(sales, 0) >= v_hi_sales
                                 or coalesce((select value_hint_cents from public.pricing_cards x where x.card_id = stats.card_id), 0) >= v_hi_val
                              then 'high' else 'normal' end as priority
      from stats
  )
  update public.pricing_cards pc set active_listings = pr.n, priority = pr.priority,
         next_refresh_at = case when pr.priority = 'dormant' then null
                                else least(coalesce(pc.next_refresh_at, now()),
                                           coalesce(pc.refreshed_at, now()) + public._pricing_interval(pr.priority, pc.value_hint_cents)) end
    from pr where pr.card_id = pc.card_id;

  update public.card_values cv set priority = pc.priority, next_refresh_at = pc.next_refresh_at
    from public.pricing_cards pc where pc.card_id = cv.card_id
     and (cv.priority is distinct from pc.priority or cv.next_refresh_at is distinct from pc.next_refresh_at);

  select jsonb_object_agg(priority, n) into v_counts from (select priority, count(*) n from public.pricing_cards group by priority) t;
  return jsonb_build_object('ok', true, 'cards', coalesce(v_counts, '{}'::jsonb));
end $$;

-- ── Admin: listings that couldn't be matched ──────────────────────────────────
create or replace function public._pricing_is_admin() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if public._listing_is_service() then return true; end if;
  if to_regprocedure('public.is_cardshow_admin()') is not null then
    return coalesce((select public.is_cardshow_admin()), false);
  end if;
  return exists (select 1 from public.admins where id = auth.uid());
end $$;
revoke all on function public._pricing_is_admin() from public, anon;

create or replace function public.pricing_unmatched(p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public._pricing_is_admin() then raise exception 'admin_only'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('identity', identity, 'status', status, 'listings', n, 'card', sample) order by n desc)
      from (select pricing_identity as identity, pricing_match_status as status, count(*) n,
                   (array_agg(jsonb_build_object('id', id, 'title', card_title, 'player', player, 'year', year, 'set', card_set,
                                                 'number', card_number, 'parallel', parallel, 'grade_key', grade_key)))[1] as sample
              from public.inventory
             where pricing_match_status in ('no_match','error') and listing_status in ('active','reserved')
             group by pricing_identity, pricing_match_status
             order by count(*) desc limit least(greatest(p_limit, 1), 500)) t), '[]'::jsonb);
end $$;

-- Admin match by hand (card id from Card Hedge), or p_card_id null to send the listings back to the queue.
create or replace function public.pricing_set_match(p_identity text, p_card_id text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not public._pricing_is_admin() then raise exception 'admin_only'; end if;
  perform set_config('cardshow.pricing_fn', 'on', true);
  if p_card_id is null then
    update public.inventory set pricing_match_status = null, pricing_match_attempts = 0, pricing_card_id = null
     where pricing_identity = p_identity and pricing_match_status in ('no_match','error','manual');
  else
    insert into public.pricing_cards (card_id, requested_at) values (p_card_id, now())
    on conflict (card_id) do update set requested_at = coalesce(pricing_cards.requested_at, now());
    update public.inventory set pricing_card_id = p_card_id, pricing_match_status = 'manual', pricing_matched_at = now()
     where pricing_identity = p_identity;
  end if;
  get diagnostics v_n = row_count;
  perform set_config('cardshow.pricing_fn', 'off', true);
  return jsonb_build_object('ok', true, 'listings', v_n);
end $$;

-- ── Service: rate limits (fixed window) ───────────────────────────────────────
create or replace function public.rate_limit_hit(p_key text, p_window_seconds int, p_max int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_start timestamptz; v_hits int;
begin
  perform public._require_service();
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.api_rate_limits (key, window_start, hits) values (p_key, v_start, 1)
  on conflict (key, window_start) do update set hits = api_rate_limits.hits + 1
  returning hits into v_hits;
  if random() < 0.01 then delete from public.api_rate_limits where window_start < now() - interval '1 day'; end if;
  return jsonb_build_object('allowed', v_hits <= p_max, 'hits', v_hits, 'limit', p_max,
                            'reset_at', v_start + make_interval(secs => p_window_seconds));
end $$;

-- ── Saved searches ────────────────────────────────────────────────────────────
create or replace function public._saved_search_cap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.saved_searches where user_id = new.user_id) >= 50 then
    raise exception 'saved_search_limit' using hint = 'Up to 50 saved searches.';
  end if;
  new.last_checked_at := now();
  return new;
end $$;
drop trigger if exists saved_searches_cap on public.saved_searches;
create trigger saved_searches_cap before insert on public.saved_searches
  for each row execute function public._saved_search_cap();

-- Searches due for an alert check (at most hourly), with the owner's email (service only).
create or replace function public.saved_searches_due(p_limit int default 200)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._require_service();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'user_id', s.user_id, 'name', s.name, 'params', s.params,
                                        'last_checked_at', s.last_checked_at,
                                        'email', (select to_jsonb(u)->>'email' from auth.users u where u.id = s.user_id)))
      from (select * from public.saved_searches
             where alerts and last_checked_at <= now() - interval '1 hour'
             order by last_checked_at limit least(greatest(p_limit, 1), 1000)) s), '[]'::jsonb);
end $$;

create or replace function public.saved_search_checked(p_id uuid, p_checked_at timestamptz, p_alerted boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_service();
  update public.saved_searches set last_checked_at = p_checked_at,
         last_alerted_at = case when p_alerted then now() else last_alerted_at end
   where id = p_id;
end $$;

-- ── Grants ────────────────────────────────────────────────────────────────────
revoke all on function public.search_listings(jsonb), public.get_listing(uuid), public.get_dealer_storefront(text),
                       public.list_upcoming_shows(jsonb), public.request_card_value_refresh(uuid) from public;
grant execute on function public.search_listings(jsonb), public.get_listing(uuid), public.get_dealer_storefront(text),
                          public.list_upcoming_shows(jsonb), public.request_card_value_refresh(uuid) to anon, authenticated, service_role;

revoke all on function public.pricing_claim_work(int, int), public.pricing_record_match(text, text, text, text, text),
                       public.pricing_apply_values(text, jsonb, text), public.pricing_bump_usage(text, int, int, int),
                       public.pricing_mark_alert(text), public.pricing_recalc_priorities(),
                       public.rate_limit_hit(text, int, int), public.saved_searches_due(int),
                       public.saved_search_checked(uuid, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.pricing_claim_work(int, int), public.pricing_record_match(text, text, text, text, text),
                          public.pricing_apply_values(text, jsonb, text), public.pricing_bump_usage(text, int, int, int),
                          public.pricing_mark_alert(text), public.pricing_recalc_priorities(),
                          public.rate_limit_hit(text, int, int), public.saved_searches_due(int),
                          public.saved_search_checked(uuid, timestamptz, boolean)
  to service_role;

revoke all on function public.pricing_unmatched(int), public.pricing_set_match(text, text) from public, anon;
grant execute on function public.pricing_unmatched(int), public.pricing_set_match(text, text) to authenticated, service_role;

commit;
