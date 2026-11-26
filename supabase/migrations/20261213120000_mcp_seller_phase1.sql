-- Seller MCP server, Phase 1 (read-only seller tools behind Supabase OAuth). Run after
-- 20261130120000_marketplace_pricing_search.sql (agent_actions, card_values) and the RLS lockdown migrations.
-- Re-runnable.
--
-- What it adds
--   mcp_client_grants      which assistant (OAuth client) a dealer connected, with the scopes they approved
--   assistant_grant_consent / assistant_revoke_client   called by the consent page and the app (normal session only)
--   _mcp_require(scope)    every seller tool: signed in, through OAuth, a seller, connected, scope approved
--   mcp_session / mcp_my_inventory / mcp_my_card / mcp_price_suggestions / mcp_my_shows /
--   mcp_sales_summary / mcp_stale_inventory    the Phase 1 tools (only the caller's own data)
--   mcp_pre_request()      PostgREST pre-request hook: an OAuth (assistant) token may only call /rpc/mcp_* functions,
--                          so it can't read or write tables or call the app's other functions directly
--   a restrictive storage policy: assistant tokens can't touch Storage
--   agent_actions columns for the action log (status, client_request_id, preview, result, ...)
--
-- How an assistant token is recognised: Supabase's OAuth server puts the client's id in the access token's
-- `client_id` claim. A normal app session has no such claim, so nothing changes for the app.
--
-- Pricing: comps come only from Card Hedge (inventory.comp_value_cents, which only the Card Hedge pricing job
-- writes, for cards with a pricing_card_id, and card_values rows with source 'cardhedge'). Never price_cache
-- (PriceCharting / CardSight).

-- ── action log columns ───────────────────────────────────────────────────────
alter table public.agent_actions
  add column if not exists client_id          text,
  add column if not exists client_name        text,
  add column if not exists status             text,
  add column if not exists client_request_id  uuid,
  add column if not exists arguments          jsonb,
  add column if not exists preview            jsonb,
  add column if not exists result             jsonb,
  add column if not exists applied_at         timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'agent_actions_status_check') then
    alter table public.agent_actions add constraint agent_actions_status_check
      check (status is null or status in ('read', 'previewed', 'applied', 'rejected', 'failed'));
  end if;
end $$;
create unique index if not exists agent_actions_owner_request_key
  on public.agent_actions (owner_id, client_request_id) where client_request_id is not null;

-- ── connected assistants ─────────────────────────────────────────────────────
create table if not exists public.mcp_client_grants (
  user_id       uuid not null references auth.users(id) on delete cascade,
  client_id     text not null,
  client_name   text,
  scopes        text[] not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  primary key (user_id, client_id)
);
alter table public.mcp_client_grants enable row level security;
drop policy if exists mcp_client_grants_own_read on public.mcp_client_grants;
create policy mcp_client_grants_own_read on public.mcp_client_grants for select to authenticated
  using (user_id = auth.uid());
revoke all on public.mcp_client_grants from anon, authenticated;
grant select on public.mcp_client_grants to authenticated;
grant all on public.mcp_client_grants to service_role;

-- Claims of the request's JWT ({} when none).
create or replace function public._mcp_claims() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
create or replace function public._mcp_client_id() returns text
language sql stable as $$ select nullif(public._mcp_claims()->>'client_id', '') $$;
grant execute on function public._mcp_claims(), public._mcp_client_id() to anon, authenticated, service_role;

create or replace function public._mcp_scopes_all() returns text[]
language sql immutable as $$ select array['inventory:read','inventory:write','sales:write','offers:write'] $$;

-- Consent page: store what the dealer approved for this assistant. Normal session only.
create or replace function public.assistant_grant_consent(p_client_id text, p_client_name text, p_scopes text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_scopes text[];
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if public._mcp_client_id() is not null then raise exception 'assistant_token_not_allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.sellers where id = v_uid) then return jsonb_build_object('error', 'not_a_seller'); end if;
  if coalesce(trim(p_client_id), '') = '' or length(p_client_id) > 200 then return jsonb_build_object('error', 'bad_client'); end if;
  select array_agg(distinct s order by s) into v_scopes from unnest(coalesce(p_scopes, '{}')) s;
  if v_scopes is null or not ('inventory:read' = any(v_scopes)) then return jsonb_build_object('error', 'read_scope_required'); end if;
  if exists (select 1 from unnest(v_scopes) s where not (s = any(public._mcp_scopes_all()))) then
    return jsonb_build_object('error', 'bad_scope');
  end if;
  insert into public.mcp_client_grants (user_id, client_id, client_name, scopes)
  values (v_uid, p_client_id, left(nullif(trim(coalesce(p_client_name, '')), ''), 120), v_scopes)
  on conflict (user_id, client_id) do update
    set client_name = excluded.client_name, scopes = excluded.scopes, updated_at = now(), revoked_at = null;
  return jsonb_build_object('ok', true, 'client_id', p_client_id, 'scopes', to_jsonb(v_scopes));
end $$;

-- Disconnect: the assistant's token stops working for every seller tool at once.
create or replace function public.assistant_revoke_client(p_client_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); n int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if public._mcp_client_id() is not null then raise exception 'assistant_token_not_allowed' using errcode = '42501'; end if;
  update public.mcp_client_grants set revoked_at = now(), updated_at = now()
   where user_id = v_uid and client_id = p_client_id and revoked_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'revoked', n > 0);
end $$;
revoke all on function public.assistant_grant_consent(text, text, text[]), public.assistant_revoke_client(text) from public, anon;
grant execute on function public.assistant_grant_consent(text, text, text[]), public.assistant_revoke_client(text) to authenticated;

-- Every seller tool starts here. Returns the dealer's id or raises a coded error the MCP server turns into a
-- message the assistant can relay. p_scope null = any connected assistant (whoami).
create or replace function public._mcp_require(p_scope text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_client text := public._mcp_client_id(); g public.mcp_client_grants%rowtype;
begin
  if v_uid is null then raise exception 'mcp:not_authenticated' using errcode = '28000'; end if;
  if v_client is null then raise exception 'mcp:oauth_required' using errcode = '28000'; end if;
  if not exists (select 1 from public.sellers where id = v_uid) then raise exception 'mcp:not_a_seller' using errcode = '42501'; end if;
  select * into g from public.mcp_client_grants where user_id = v_uid and client_id = v_client;
  if not found or g.revoked_at is not null then raise exception 'mcp:not_connected' using errcode = '42501'; end if;
  if p_scope is not null and not (p_scope = any(g.scopes)) then
    raise exception 'mcp:scope_missing:%', p_scope using errcode = '42501';
  end if;
  return v_uid;
end $$;
revoke all on function public._mcp_require(text) from public, anon;
grant execute on function public._mcp_require(text) to authenticated;

-- ── small helpers ────────────────────────────────────────────────────────────
create or replace function public._mcp_dollars(p_cents numeric) returns text
language sql immutable as $$
  select case when p_cents is null then null
              when p_cents < 0 then '-' || to_char(abs(p_cents) / 100.0, 'FM$999,999,990.00')
              else to_char(p_cents / 100.0, 'FM$999,999,990.00') end $$;
create or replace function public._mcp_num(p text) returns numeric
language sql immutable as $$ select case when trim(coalesce(p, '')) ~ '^-?\d+(\.\d+)?$' then trim(p)::numeric end $$;
create or replace function public._mcp_cents(p text) returns bigint
language sql immutable as $$ select round(public._mcp_num(p) * 100)::bigint $$;
create or replace function public._mcp_is_graded(r jsonb) returns boolean
language sql immutable as $$
  select coalesce(nullif(trim(r->>'grader'), ''), 'raw') !~* '^raw$' $$;
create or replace function public._mcp_card_status(r jsonb) returns text
language sql immutable as $$
  select case when lower(coalesce(r->>'status', '')) = 'sold' or r->>'listing_status' = 'sold' then 'sold'
              when r->>'listing_status' = 'reserved' then 'held'
              else 'available' end $$;
-- A comp is shown only when it's Card Hedge's (pricing_card_id set) and passed CardShow's checks: matched by
-- hand, or matched automatically and within 1/5–5× the asking price (same band as the buyer site).
create or replace function public._mcp_comp_visible(r jsonb) returns boolean
language sql immutable as $$
  select nullif(r->>'comp_value_cents', '') is not null and nullif(r->>'pricing_card_id', '') is not null
     and (r->>'pricing_match_status' = 'manual'
          or (r->>'pricing_match_status' = 'matched'
              and (public._mcp_num(r->>'pct_of_comp') is null or public._mcp_num(r->>'pct_of_comp') between 0.2 and 5))) $$;
create or replace function public._mcp_show_ended(s public.shows) returns boolean
language sql stable as $$ select coalesce(s.end_date, s.start_date) < current_date or (s.start_date is null and s.status = 'past') $$;

-- One card as returned to assistants. r = to_jsonb(inventory row), so columns a project lacks just read as null.
create or replace function public._mcp_card_json(r jsonb, p_detail boolean default false) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_price bigint := public._mcp_cents(r->>'price');
  v_comp_ok boolean := public._mcp_comp_visible(r);
  v_comp bigint := (r->>'comp_value_cents')::bigint;
  v_shows jsonb; v_out jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'start_date', s.start_date,
           'end_date', coalesce(s.end_date, s.start_date), 'ended', public._mcp_show_ended(s))
           order by s.start_date desc nulls last), '[]'::jsonb)
    into v_shows
    from public.show_inventory si join public.shows s on s.id = si.show_id
   where si.card_id = (r->>'id')::uuid;
  v_out := jsonb_build_object(
    'id', r->>'id',
    'title', r->>'card_title',
    'stock_code', r->>'stock_code',
    'player', r->>'player', 'year', r->>'year', 'set', r->>'card_set', 'card_number', r->>'card_number',
    'parallel', r->>'parallel', 'serial_number', r->>'serial_number', 'print_run_size', r->>'print_run_size',
    'features', r->'features', 'category', r->>'category', 'subcategory', r->>'subcategory',
    'item_type', coalesce(r->>'item_type', 'card'), 'product_type', r->>'product_type',
    'graded', public._mcp_is_graded(r),
    'grader', nullif(r->>'grader', ''), 'grade', r->>'grade', 'cert_number', nullif(r->>'cert_number', ''),
    'condition', r->>'condition',
    'price_cents', v_price, 'price', public._mcp_dollars(v_price),
    'status', public._mcp_card_status(r), 'listing_status', r->>'listing_status',
    'needs_details', r->>'identification_status' = 'unidentified',
    'location', r->>'location',
    'quantity', 1,
    'comp', case when v_comp_ok then jsonb_build_object('value_cents', v_comp, 'value', public._mcp_dollars(v_comp),
                                                        'source', 'Card Hedge', 'refreshed_at', r->>'comp_refreshed_at')
                 else jsonb_build_object('value_cents', null, 'note', 'No comp yet') end,
    'pct_of_comp', case when v_comp_ok and v_price is not null and v_comp > 0 then round(v_price::numeric / v_comp, 3) end,
    'shows', v_shows,
    'photo', jsonb_build_object('has_seller_photo', nullif(r->>'primary_capture_id', '') is not null,
                                'public_photo_path', r->>'public_photo_path',
                                'catalog_image_id', coalesce(nullif(r->>'stock_image_id', ''), nullif(r->>'catalog_card_id', ''))),
    'created_at', r->>'created_at');
  if lower(coalesce(r->>'status', '')) = 'sold' then
    v_out := v_out || jsonb_build_object('sale', jsonb_build_object(
      'sold_price_cents', public._mcp_cents(r->>'sold_price'), 'sold_price', public._mcp_dollars(public._mcp_cents(r->>'sold_price')),
      'payment_method', r->>'payment_method', 'sold_date', r->>'sold_date'));
  end if;
  if p_detail then
    v_out := v_out || jsonb_build_object('notes', r->>'sale_notes');
  end if;
  return v_out;
end $$;

-- ── whoami ──────────────────────────────────────────────────────────────────
create or replace function public.mcp_session() returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare v_uid uuid := public._mcp_require(null); s record; g record;
begin
  select handle, display_name into s from public.sellers where id = v_uid;
  select client_id, client_name, scopes into g from public.mcp_client_grants
   where user_id = v_uid and client_id = public._mcp_client_id();
  return jsonb_build_object('user_id', v_uid, 'handle', s.handle, 'display_name', s.display_name,
    'client_id', g.client_id, 'client_name', g.client_name, 'scopes', to_jsonb(g.scopes));
end $$;

-- ── list_my_inventory ───────────────────────────────────────────────────────
create or replace function public.mcp_my_inventory(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:read');
  v_words text[] := array(select w from regexp_split_to_table(lower(trim(coalesce(p->>'text', ''))), '\s+') w where w <> '');
  v_status text := lower(coalesce(nullif(p->>'status', ''), 'unsold'));
  v_missing text[] := array(select jsonb_array_elements_text(case when jsonb_typeof(p->'missing_fields') = 'array' then p->'missing_fields' else '[]'::jsonb end));
  v_sort text := coalesce(nullif(p->>'sort', ''), 'newest');
  v_limit int := least(greatest(coalesce(public._mcp_num(p->>'limit')::int, 25), 1), 100);
  v_offset int := greatest(coalesce(public._mcp_num(p->>'offset')::int, 0), 0);
  v_total int; v_rows jsonb;
begin
  if v_status not in ('available', 'held', 'sold', 'unsold', 'all') then raise exception 'mcp:bad_input:status must be available, held, sold, unsold or all' using errcode = '22023'; end if;
  if exists (select 1 from unnest(v_missing) m where m not in ('price','player','year','set','grade','cert','photo','comp','title')) then
    raise exception 'mcp:bad_input:missing_fields can be price, player, year, set, grade, cert, photo, comp, title' using errcode = '22023';
  end if;
  with base as (
    select to_jsonb(i) r from public.inventory i where i.seller_id = v_uid
  ), f as (
    select r, public._mcp_cents(r->>'price') price, public._mcp_num(r->>'grade') grade_n, public._mcp_num(r->>'year') year_n,
           public._mcp_card_status(r) st,
           lower(concat_ws(' ', r->>'card_title', r->>'player', r->>'year', r->>'card_set', r->>'card_number', r->>'parallel',
                           r->>'grader', r->>'grade', r->>'cert_number', r->>'stock_code', r->>'subcategory')) hay,
           regexp_replace(upper(coalesce(r->>'stock_code', '')), '[^A-Z0-9]', '', 'g') code_key
      from base
  ), g as (
    select * from f
     where (v_status = 'all' or (v_status = 'unsold' and st <> 'sold') or st = v_status)
       and not exists (select 1 from unnest(v_words) w
                        where position(w in hay) = 0
                          and (code_key = '' or regexp_replace(upper(w), '[^A-Z0-9]', '', 'g') <> code_key))
       and (p->>'player' is null or r->>'player' ilike '%' || (p->>'player') || '%')
       and (p->>'set' is null or r->>'card_set' ilike '%' || (p->>'set') || '%')
       and (p->>'year_min' is null or year_n >= public._mcp_num(p->>'year_min'))
       and (p->>'year_max' is null or year_n <= public._mcp_num(p->>'year_max'))
       and (p->>'grader' is null or lower(r->>'grader') = lower(p->>'grader'))
       and (p->>'grade_min' is null or grade_n >= public._mcp_num(p->>'grade_min'))
       and (p->>'grade_max' is null or grade_n <= public._mcp_num(p->>'grade_max'))
       and (p->>'raw' is null or (p->>'raw')::boolean = not public._mcp_is_graded(r))
       and (p->>'price_min_cents' is null or price >= public._mcp_num(p->>'price_min_cents'))
       and (p->>'price_max_cents' is null or price <= public._mcp_num(p->>'price_max_cents'))
       and (p->>'show_id' is null or exists (select 1 from public.show_inventory si where si.card_id = (r->>'id')::uuid and si.show_id = p->>'show_id'))
       and (not ('price' = any(v_missing))  or coalesce(price, 0) = 0)
       and (not ('player' = any(v_missing)) or coalesce(trim(r->>'player'), '') = '')
       and (not ('year' = any(v_missing))   or year_n is null)
       and (not ('set' = any(v_missing))    or coalesce(trim(r->>'card_set'), '') = '')
       and (not ('title' = any(v_missing))  or coalesce(trim(r->>'card_title'), '') = '')
       and (not ('grade' = any(v_missing))  or (public._mcp_is_graded(r) and coalesce(trim(r->>'grade'), '') = ''))
       and (not ('cert' = any(v_missing))   or (public._mcp_is_graded(r) and coalesce(trim(r->>'cert_number'), '') = ''))
       and (not ('photo' = any(v_missing))  or (coalesce(r->>'item_type', 'card') <> 'sealed'
                                                and nullif(r->>'primary_capture_id', '') is null and nullif(r->>'stock_image_id', '') is null))
       and (not ('comp' = any(v_missing))   or not public._mcp_comp_visible(r))
  )
  select (select count(*) from g),
         coalesce((select jsonb_agg(public._mcp_card_json(x.r) order by x.ord) from (
           select r, row_number() over (order by
               case when v_sort = 'price_desc' then price end desc nulls last,
               case when v_sort = 'price_asc'  then price end asc nulls last,
               case when v_sort = 'pct_of_comp_desc' and public._mcp_comp_visible(r) then price::numeric / nullif((r->>'comp_value_cents')::numeric, 0) end desc nulls last,
               case when v_sort = 'pct_of_comp_asc'  and public._mcp_comp_visible(r) then price::numeric / nullif((r->>'comp_value_cents')::numeric, 0) end asc nulls last,
               case when v_sort = 'player' then lower(r->>'player') end asc nulls last,
               case when v_sort = 'oldest' then r->>'created_at' end asc,
               r->>'created_at' desc, r->>'id') ord
             from g order by ord limit v_limit offset v_offset) x), '[]'::jsonb)
    into v_total, v_rows;
  return jsonb_build_object('total', v_total, 'offset', v_offset, 'limit', v_limit, 'results', v_rows);
end $$;

-- ── get_my_card ─────────────────────────────────────────────────────────────
create or replace function public.mcp_my_card(p_id uuid) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare v_uid uuid := public._mcp_require('inventory:read'); r jsonb; v_out jsonb; v_check jsonb;
begin
  select to_jsonb(i) into r from public.inventory i where i.id = p_id and i.seller_id = v_uid;
  if r is null then return jsonb_build_object('error', 'not_found'); end if;
  v_out := public._mcp_card_json(r, true);
  if to_regclass('public.cert_trust_checks') is not null and public._mcp_is_graded(r) then
    execute $q$select to_jsonb(c) from public.cert_trust_checks c where c.inventory_id = $1 and c.seller_id = $2
               order by c.checked_at desc limit 1$q$ into v_check using p_id, v_uid;
  end if;
  v_out := v_out || jsonb_build_object('gtcr', case when not public._mcp_is_graded(r) or coalesce(r->>'cert_number', '') = '' then
      jsonb_build_object('status', 'not_applicable')
    else jsonb_build_object(
      'status', case when r->>'trust_flag' = 'flagged' then case when (v_check->>'has_stolen_report')::boolean then 'stolen_report'
                                                                 when (v_check->>'has_lost_report')::boolean then 'lost_report' else 'flagged' end
                     when r->>'trust_flag' = 'disputed' then 'disputed_by_you'
                     when v_check is null then 'not_checked'
                     when (v_check->>'matched')::boolean then 'report_on_file'
                     else 'clear' end,
      'last_checked_at', v_check->>'checked_at',
      'clear_badge_until', case when nullif(r->>'trust_clear_at', '') is not null then ((r->>'trust_clear_at')::timestamptz + interval '7 days') end)
    end,
    'price_history', null,
    'price_history_note', 'CardShow does not keep a price history yet.');
  return v_out;
end $$;

-- Card Hedge detail (range, sales count) for the caller's own cards only. card_values itself stays unreadable.
create or replace function public._mcp_card_values(p_ids uuid[])
returns table (inventory_id uuid, low_cents integer, high_cents integer, sales_30d integer, refreshed_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.id, cv.low_cents, cv.high_cents, cv.sales_30d, cv.refreshed_at
    from public.inventory i
    join public.card_values cv on cv.card_id = i.pricing_card_id and cv.grade = i.grade_key and cv.source = 'cardhedge'
   where auth.uid() is not null and i.seller_id = auth.uid() and i.id = any(p_ids)
$$;
revoke all on function public._mcp_card_values(uuid[]) from public, anon;
grant execute on function public._mcp_card_values(uuid[]) to authenticated;

-- ── get_price_suggestion ────────────────────────────────────────────────────
create or replace function public.mcp_price_suggestions(p_ids uuid[], p_target_pct numeric default null) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:read');
  v_pct numeric := coalesce(p_target_pct, 1.0);
  v_out jsonb := '[]'::jsonb; v_id uuid; r jsonb; cv record; v_comp bigint; v_price bigint; v_sugg bigint; v_conf text;
begin
  if p_ids is null or cardinality(p_ids) = 0 then raise exception 'mcp:bad_input:inventory_ids is required' using errcode = '22023'; end if;
  if cardinality(p_ids) > 50 then raise exception 'mcp:bad_input:At most 50 cards per call' using errcode = '22023'; end if;
  if v_pct <= 0 or v_pct > 3 then raise exception 'mcp:bad_input:target_pct_of_comp must be between 0.01 and 3 (1 = 100%% of comp)' using errcode = '22023'; end if;
  foreach v_id in array (select array_agg(distinct x) from unnest(p_ids) x) loop
    select to_jsonb(i) into r from public.inventory i where i.id = v_id and i.seller_id = v_uid;
    if r is null then
      v_out := v_out || jsonb_build_array(jsonb_build_object('inventory_id', v_id, 'error', 'not_found'));
      continue;
    end if;
    v_price := public._mcp_cents(r->>'price');
    if not public._mcp_comp_visible(r) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('inventory_id', v_id, 'title', r->>'card_title',
        'current_price_cents', v_price, 'current_price', public._mcp_dollars(v_price),
        'comp', null, 'suggested_price_cents', null, 'note', 'No comp yet'));
      continue;
    end if;
    v_comp := (r->>'comp_value_cents')::bigint;
    select * into cv from public._mcp_card_values(array[v_id]);
    v_sugg := greatest(round(v_comp * v_pct / 100.0) * 100, 100)::bigint;   -- whole dollars, at least $1
    v_conf := case when cv.sales_30d is null then 'low' when cv.sales_30d >= 10 then 'high'
                   when cv.sales_30d >= 3 then 'medium' else 'low' end;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'inventory_id', v_id, 'title', r->>'card_title',
      'current_price_cents', v_price, 'current_price', public._mcp_dollars(v_price),
      'comp', jsonb_build_object('value_cents', v_comp, 'value', public._mcp_dollars(v_comp),
                                 'low_cents', cv.low_cents, 'low', public._mcp_dollars(cv.low_cents),
                                 'high_cents', cv.high_cents, 'high', public._mcp_dollars(cv.high_cents),
                                 'sales_30d', cv.sales_30d, 'grade', r->>'grade_key',
                                 'refreshed_at', coalesce(cv.refreshed_at::text, r->>'comp_refreshed_at'), 'source', 'Card Hedge'),
      'target_pct_of_comp', v_pct,
      'suggested_price_cents', v_sugg, 'suggested_price', public._mcp_dollars(v_sugg),
      'current_pct_of_comp', case when v_price is not null and v_comp > 0 then round(v_price::numeric / v_comp, 3) end,
      'confidence', v_conf,
      'note', case when v_conf = 'low' then 'Few recent sales behind this comp; treat it as a rough guide.' end));
  end loop;
  return jsonb_build_object('results', v_out);
end $$;

-- ── list_my_shows ───────────────────────────────────────────────────────────
create or replace function public.mcp_my_shows(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:read');
  v_when text := lower(coalesce(nullif(p->>'when', ''), 'upcoming'));
  v_limit int := least(greatest(coalesce(public._mcp_num(p->>'limit')::int, 20), 1), 100);
  v_rows jsonb;
begin
  if v_when not in ('upcoming', 'past', 'all') then raise exception 'mcp:bad_input:when must be upcoming, past or all' using errcode = '22023'; end if;
  with mine as (
    select show_id from public.show_sellers where seller_id = v_uid
    union select si.show_id from public.show_inventory si join public.inventory i on i.id = si.card_id where i.seller_id = v_uid
    union select show_id from public.show_floor_transactions where seller_id = v_uid and show_id is not null
  ), s as (
    select sh.*, public._mcp_show_ended(sh) ended from public.shows sh where sh.id in (select show_id from mine)
  )
  select coalesce(jsonb_agg(x.j order by x.k1, x.k2), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('id', s.id, 'name', s.name, 'date', s.date, 'start_date', s.start_date,
             'end_date', coalesce(s.end_date, s.start_date), 'venue', s.venue, 'city', s.city, 'state', s.state,
             'status', case when s.ended then 'past' else coalesce(s.status, 'upcoming') end,
             'table_number', (select ss.table_number from public.show_sellers ss where ss.show_id = s.id and ss.seller_id = v_uid limit 1),
             'joined', exists (select 1 from public.show_sellers ss where ss.show_id = s.id and ss.seller_id = v_uid),
             'cards_published', (select count(*) from public.show_inventory si join public.inventory i on i.id = si.card_id
                                  where si.show_id = s.id and i.seller_id = v_uid)) j,
           case when v_when = 'past' then -coalesce(extract(epoch from s.start_date), 0) else coalesce(extract(epoch from s.start_date), 1e12) end k1,
           s.id k2
      from s
     where v_when = 'all' or (v_when = 'past' and s.ended) or (v_when = 'upcoming' and not s.ended)
     order by 2, 3 limit v_limit) x;
  return jsonb_build_object('shows', v_rows);
end $$;

-- ── sales_summary ───────────────────────────────────────────────────────────
-- Cash sales: the shared ledger (the caller's rows, undone sales left out) plus sales at the dealer's own
-- private shows (dealer_transactions). Trades and buys aren't sales and are not counted.
create or replace function public.mcp_sales_summary(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:read');
  v_show text := nullif(p->>'show_id', '');
  v_from date; v_to date;
  v_private jsonb := '[]'::jsonb;
  v_out jsonb; v_brought int; v_sold_in_show int;
begin
  begin
    v_from := nullif(p->>'date_from', '')::date; v_to := nullif(p->>'date_to', '')::date;
  exception when others then
    raise exception 'mcp:bad_input:Dates must look like 2026-11-07' using errcode = '22023';
  end;
  if v_show is null and v_from is null and v_to is null then
    raise exception 'mcp:bad_input:Give a show_id or a date range (date_from / date_to)' using errcode = '22023';
  end if;
  if to_regclass('public.dealer_transactions') is not null then
    execute $q$select coalesce(jsonb_agg(jsonb_build_object('sold_at', d.occurred_at, 'cents', round(d.cash_in * 100)::bigint,
                 'method', d.payment_method, 'show_id', d.show_id)), '[]'::jsonb)
                 from public.dealer_transactions d where d.owner_id = $1 and d.txn_type in ('sale', 'lot_sale')$q$
      into v_private using v_uid;
  end if;
  if v_show is not null then
    select count(*), count(*) filter (where lower(coalesce(i.status, '')) = 'sold' and coalesce(i.payment_method, '') <> 'Trade')
      into v_brought, v_sold_in_show
      from public.show_inventory si join public.inventory i on i.id = si.card_id
     where si.show_id = v_show and i.seller_id = v_uid;
  end if;
  with led as (
    select to_jsonb(t) r from public.show_floor_transactions t where t.seller_id = v_uid
  ), voided as (
    select r->>'voids_transaction_id' id from led where nullif(r->>'voids_transaction_id', '') is not null
  ), sales as (
    select 'ledger' src, coalesce((r->>'sold_at')::timestamptz, (r->>'created_at')::timestamptz) sold_at,
           public._mcp_cents(r->>'sold_price') cents, coalesce(nullif(r->>'payment_method', ''), 'Other') method,
           coalesce(nullif(r->>'category', ''), 'Unknown') category, r->>'card_title' title, r->>'player' player,
           r->>'show_id' show_id, nullif(r->>'inventory_id', '')::uuid inventory_id
      from led
     where public._mcp_num(r->>'sold_price') >= 0 and nullif(r->>'voids_transaction_id', '') is null
       and (r->>'id') not in (select id from voided)
    union all
    select 'private', (e->>'sold_at')::timestamptz, (e->>'cents')::bigint, coalesce(nullif(e->>'method', ''), 'Other'),
           'Unknown', null, null, e->>'show_id', null
      from jsonb_array_elements(v_private) e
  ), f as (
    select * from sales
     where (v_show is null or show_id = v_show)
       and (v_from is null or sold_at::date >= v_from)
       and (v_to is null or sold_at::date <= v_to)
  )
  select jsonb_build_object(
    'show_id', v_show, 'date_from', v_from, 'date_to', v_to,
    'total_cents', coalesce((select sum(cents) from f), 0),
    'total', public._mcp_dollars(coalesce((select sum(cents) from f), 0)),
    'sales_count', (select count(*) from f),
    'average_cents', (select round(avg(cents))::bigint from f),
    'average', public._mcp_dollars((select round(avg(cents))::bigint from f)),
    'by_payment_method', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'count', n, 'total_cents', t, 'total', public._mcp_dollars(t)) order by t desc)
                                    from (select method, count(*) n, sum(cents) t from f group by method) m), '[]'::jsonb),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'count', n, 'total_cents', t, 'total', public._mcp_dollars(t)) order by t desc)
                              from (select category, count(*) n, sum(cents) t from f group by category) c), '[]'::jsonb),
    'top_sales', coalesce((select jsonb_agg(jsonb_build_object('title', coalesce(title, case when src = 'private' then 'Sale at a private show' else 'Lot sale' end),
                                    'player', player, 'price_cents', cents, 'price', public._mcp_dollars(cents), 'sold_at', sold_at,
                                    'show_id', show_id, 'inventory_id', inventory_id) order by cents desc)
                            from (select * from f order by cents desc limit 10) t), '[]'::jsonb),
    'sell_through', case when v_show is not null then jsonb_build_object('cards_brought', v_brought, 'cards_sold', v_sold_in_show,
                      'pct', case when v_brought > 0 then round(v_sold_in_show::numeric / v_brought, 3) end) end,
    'note', 'Cash sales only. Trades and buys are on Show Home in the app.')
    into v_out;
  return v_out;
end $$;

-- ── stale_inventory ─────────────────────────────────────────────────────────
-- Counts the ended shows a card is still published to. CardShow doesn't keep publish history, so a card taken
-- off a show doesn't count.
create or replace function public.mcp_stale_inventory(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:read');
  v_min int := greatest(coalesce(public._mcp_num(p->>'min_shows')::int, 3), 1);
  v_age int := public._mcp_num(p->>'min_age_days')::int;
  v_limit int := least(greatest(coalesce(public._mcp_num(p->>'limit')::int, 50), 1), 100);
  v_rows jsonb; v_total int;
begin
  with c as (
    select to_jsonb(i) r, count(s.id) n, max(coalesce(s.end_date, s.start_date)) last_show
      from public.inventory i
      join public.show_inventory si on si.card_id = i.id
      join public.shows s on s.id = si.show_id and public._mcp_show_ended(s)
     where i.seller_id = v_uid and lower(coalesce(i.status, '')) <> 'sold'
       and (v_age is null or i.created_at <= now() - make_interval(days => v_age))
     group by i.id
    having count(s.id) >= v_min
  )
  select (select count(*) from c),
         coalesce((select jsonb_agg(public._mcp_card_json(r) || jsonb_build_object('ended_shows_count', n, 'last_show_date', last_show,
                   'age_days', (current_date - (r->>'created_at')::timestamptz::date))
                   order by n desc, last_show asc) from (select * from c order by n desc, last_show asc limit v_limit) y), '[]'::jsonb)
    into v_total, v_rows;
  return jsonb_build_object('min_shows', v_min, 'total', v_total, 'results', v_rows,
    'note', 'Counts ended shows each card is still published to; CardShow does not keep a history of shows a card was removed from.');
end $$;

revoke all on function public.mcp_session(), public.mcp_my_inventory(jsonb), public.mcp_my_card(uuid),
  public.mcp_price_suggestions(uuid[], numeric), public.mcp_my_shows(jsonb), public.mcp_sales_summary(jsonb),
  public.mcp_stale_inventory(jsonb) from public, anon;
grant execute on function public.mcp_session(), public.mcp_my_inventory(jsonb), public.mcp_my_card(uuid),
  public.mcp_price_suggestions(uuid[], numeric), public.mcp_my_shows(jsonb), public.mcp_sales_summary(jsonb),
  public.mcp_stale_inventory(jsonb) to authenticated;

-- ── assistant tokens: only the mcp_* functions ───────────────────────────────
-- PostgREST runs this before every API request. A token from an assistant (client_id claim) may only call
-- /rpc/mcp_* functions, which check the dealer's approved scopes themselves. Everything else (tables, the app's
-- other functions such as record_sale or set_offer_rules) is refused, so the token can't skip the scopes,
-- previews or the no-delete rule. Normal app sessions have no client_id and are untouched.
create or replace function public.mcp_pre_request() returns void
language plpgsql stable as $$
declare v_client text := public._mcp_client_id(); v_path text := coalesce(current_setting('request.path', true), '');
begin
  if v_client is not null and v_path !~ '^/rpc/mcp_[a-z0-9_]+$' then
    raise exception 'Assistant tokens can only use the CardShow MCP tools.' using errcode = '42501',
      hint = 'Connect at https://getcardshow.com/mcp/seller';
  end if;
end $$;
grant execute on function public.mcp_pre_request() to anon, authenticated, service_role;

-- Point PostgREST at it, unless another pre-request function is already configured (then add a call to
-- public.mcp_pre_request() inside that one by hand: see the NOTICE).
do $$
declare v_cur text;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role: skipped the PostgREST pre-request hook.'; return;
  end if;
  select split_part(c, '=', 2) into v_cur
    from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
   where r.rolname = 'authenticator' and c like 'pgrst.db_pre_request=%' limit 1;
  if v_cur is not null and v_cur not in ('public.mcp_pre_request', 'mcp_pre_request') then
    raise notice 'authenticator already has pgrst.db_pre_request = %. Call public.mcp_pre_request() from it.', v_cur;
  else
    execute 'alter role authenticator set pgrst.db_pre_request = ''public.mcp_pre_request''';
  end if;
end $$;
notify pgrst, 'reload config';

-- Storage isn't behind PostgREST: block assistant tokens there with a restrictive policy.
drop policy if exists storage_no_assistant_tokens on storage.objects;
create policy storage_no_assistant_tokens on storage.objects as restrictive for all to anon, authenticated
  using (public._mcp_client_id() is null) with check (public._mcp_client_id() is null);

-- Check after running:
--   select rolconfig from pg_roles where rolname = 'authenticator';   -- includes pgrst.db_pre_request=public.mcp_pre_request
--   select count(*) from pg_proc where proname like 'mcp\_%';          -- 8
