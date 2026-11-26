-- Seller MCP server, Phase 2: single writes with preview + confirm. Run after
-- 20261213120000_mcp_seller_phase1.sql (and the show_mode_sales, cost_tracking and RLS migrations). Re-runnable.
--
-- Every write tool is one function called twice:
--   1. without p_confirm_token: changes nothing; returns {stage:'preview', preview, confirm_token, expires_at}
--   2. with the same p_args and that token: applies exactly the previewed change; returns {stage:'applied', result}
-- The token is stored hashed, is tied to the dealer, the assistant (OAuth client), the tool and the exact arguments,
-- lasts 10 minutes and works once. If the card changed since the preview the apply is refused (data_changed).
-- record_sale needs client_request_id; repeating a request that already went through returns the first result
-- (mcp_write_results), so a retried sale is recorded once.
--
-- The functions run as the dealer (security invoker): inventory / show_inventory writes go through RLS (own cards,
-- shows the dealer joined). Only the token store and the result store are security definer helpers.
-- There are no delete tools.

-- ── sources ─────────────────────────────────────────────────────────────────
alter table public.sales drop constraint if exists sales_source_check;
alter table public.sales add constraint sales_source_check check (source in ('show_mode', 'manual_sale', 'agent'));
do $$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.show_floor_transactions'::regclass and conname = 'show_floor_transactions_source_check';
  if v_def is not null and v_def not like '%agent%' then
    alter table public.show_floor_transactions drop constraint show_floor_transactions_source_check;
    alter table public.show_floor_transactions add constraint show_floor_transactions_source_check
      check (source in ('platform', 'manual', 'community_report', 'social_extract', 'snap', 'import', 'agent'));
  end if;
end $$;

-- The log keeps one 'applied' row per request; previews and refusals may repeat the request id.
drop index if exists public.agent_actions_owner_request_key;
create unique index if not exists agent_actions_owner_request_applied_key
  on public.agent_actions (owner_id, client_request_id) where client_request_id is not null and status = 'applied';

-- ── confirmation tokens + results ───────────────────────────────────────────
create table if not exists public.mcp_confirmations (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  owner_id    uuid not null,
  client_id   text not null,
  tool        text not null,
  args        jsonb not null,
  state_hash  text,
  preview     jsonb,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists mcp_confirmations_owner_idx on public.mcp_confirmations (owner_id, created_at);
alter table public.mcp_confirmations enable row level security;
revoke all on public.mcp_confirmations from anon, authenticated;
grant all on public.mcp_confirmations to service_role;

create table if not exists public.mcp_write_results (
  owner_id          uuid not null,
  client_request_id uuid not null,
  tool              text not null,
  args              jsonb,
  result            jsonb not null,
  created_at        timestamptz not null default now(),
  primary key (owner_id, client_request_id)
);
alter table public.mcp_write_results enable row level security;
drop policy if exists mcp_write_results_own_read on public.mcp_write_results;
create policy mcp_write_results_own_read on public.mcp_write_results for select to authenticated using (owner_id = auth.uid());
revoke all on public.mcp_write_results from anon, authenticated;
grant select on public.mcp_write_results to authenticated;
grant all on public.mcp_write_results to service_role;

create or replace function public._mcp_token_hash(p_token text) returns text
language sql immutable as $$ select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') $$;

-- Preview step: store the token (hashed) and return it.
create or replace function public._mcp_confirm_issue(p_tool text, p_args jsonb, p_state text, p_preview jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public._mcp_require(null);
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_exp timestamptz := now() + interval '10 minutes';
begin
  delete from public.mcp_confirmations where owner_id = v_uid and created_at < now() - interval '1 day';
  insert into public.mcp_confirmations (token_hash, owner_id, client_id, tool, args, state_hash, preview, expires_at)
  values (public._mcp_token_hash(v_token), v_uid, public._mcp_client_id(), p_tool, p_args, p_state, p_preview, v_exp);
  return jsonb_build_object('stage', 'preview', 'preview', p_preview, 'confirm_token', v_token, 'expires_at', v_exp,
    'next', 'Show this preview to the dealer. Only if they clearly say yes, call the same tool again with exactly the same arguments plus confirm_token.');
end $$;

-- Apply step: 'ok' (token now used) or a reason. Anything but an unknown token uses the token up, so a new preview
-- is needed.
create or replace function public._mcp_confirm_take(p_tool text, p_args jsonb, p_token text, p_state text)
returns text language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._mcp_require(null); c public.mcp_confirmations%rowtype; v_reason text;
begin
  select * into c from public.mcp_confirmations where token_hash = public._mcp_token_hash(p_token) for update;
  if not found or c.owner_id <> v_uid or c.client_id is distinct from public._mcp_client_id() then return 'invalid_token'; end if;
  if c.used_at is not null then return 'token_used'; end if;
  v_reason := case
    when c.expires_at < now() then 'token_expired'
    when c.tool <> p_tool or c.args <> p_args then 'arguments_changed'
    when c.state_hash is distinct from p_state then 'data_changed'
    else 'ok' end;
  update public.mcp_confirmations set used_at = now() where id = c.id;
  return v_reason;
end $$;

-- A token that was already used is refused as such, before any other check (so a repeat reads "token_used",
-- not "no_changes").
create or replace function public._mcp_token_used(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_token is not null and exists (select 1 from public.mcp_confirmations
    where token_hash = public._mcp_token_hash(p_token) and owner_id = auth.uid() and used_at is not null)
$$;
revoke all on function public._mcp_token_used(text) from public, anon;
grant execute on function public._mcp_token_used(text) to authenticated;

create or replace function public._mcp_replay(p_request uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select r.result from public.mcp_write_results r where r.owner_id = auth.uid() and r.client_request_id = p_request
$$;
create or replace function public._mcp_store_result(p_tool text, p_request uuid, p_args jsonb, p_result jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.mcp_write_results (owner_id, client_request_id, tool, args, result)
  values (auth.uid(), p_request, p_tool, p_args, p_result) on conflict do nothing
$$;
revoke all on function public._mcp_confirm_issue(text, jsonb, text, jsonb), public._mcp_confirm_take(text, jsonb, text, text),
  public._mcp_replay(uuid), public._mcp_store_result(text, uuid, jsonb, jsonb) from public, anon;
grant execute on function public._mcp_confirm_issue(text, jsonb, text, jsonb), public._mcp_confirm_take(text, jsonb, text, text),
  public._mcp_replay(uuid), public._mcp_store_result(text, uuid, jsonb, jsonb) to authenticated;

create or replace function public._mcp_open_offers(p_id uuid) returns int
language plpgsql stable security invoker set search_path = public as $$
declare n int := 0;
begin
  if to_regclass('public.offers') is not null then
    execute 'select count(*) from public.offers where status in (''pending'',''countered'') and $1 = any(listing_ids)' into n using p_id;
  end if;
  return n;
end $$;

-- Fingerprint of everything a write depends on: if it differs between preview and apply, the apply is refused.
create or replace function public._mcp_card_state(p_id uuid) returns text
language sql stable security invoker set search_path = public as $$
  select md5(coalesce((
    select jsonb_build_object(
      'f', (select jsonb_object_agg(k, r->k) from unnest(array['price','status','listing_status','reservation_id','player',
             'year','card_set','card_number','parallel','grader','grade','cert_number','card_title','condition','location',
             'trust_flag','identification_status']) k),
      'shows', (select coalesce(jsonb_agg(si.show_id order by si.show_id), '[]'::jsonb) from public.show_inventory si where si.card_id = p_id),
      'offers', public._mcp_open_offers(p_id)
    )::text from (select to_jsonb(i) r from public.inventory i where i.id = p_id) x), ''))
$$;

-- Updates only the given columns, typed by the table itself (dashboard-made columns may differ from the docs).
create or replace function public._mcp_update_card_cols(p_uid uuid, p_id uuid, p_set jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare v_sets text;
begin
  select string_agg(format('%1$I = (jsonb_populate_record(null::public.inventory, $1)).%1$I', c.column_name), ', ')
    into v_sets
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'inventory' and c.is_generated = 'NEVER'
     and c.column_name in (select jsonb_object_keys(p_set));
  if v_sets is null then return; end if;
  execute format('update public.inventory set %s, updated_at = now() where id = $2 and seller_id = $3', v_sets)
    using p_set, p_id, p_uid;
end $$;

create or replace function public._mcp_own_card(p_uid uuid, p_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select to_jsonb(i) from public.inventory i where i.id = p_id and i.seller_id = p_uid
$$;

create or replace function public._mcp_uuid(p text) returns uuid
language plpgsql immutable as $$
begin return nullif(trim(coalesce(p, '')), '')::uuid; exception when others then return null; end $$;

-- Writes a row with only the keys that are real columns (inventory / the ledger were built in the dashboard).
create or replace function public._mcp_insert_existing(p_table text, p_row jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare v_cols text;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_cols
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = p_table and c.is_generated = 'NEVER'
     and c.column_name in (select jsonb_object_keys(p_row));
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', p_table, v_cols, v_cols, p_table)
    using p_row;
end $$;

-- Shared refusal checks for a card about to be changed. Returns an error object or null.
create or replace function public._mcp_card_blocked(r jsonb, p_allow_sold boolean) returns jsonb
language sql stable as $$
  select case
    when r is null then jsonb_build_object('error', 'not_found', 'message', 'No card with that id in your inventory.')
    when not p_allow_sold and public._mcp_card_status(r) = 'sold' then
      jsonb_build_object('error', 'sold', 'message', 'This card is already sold.')
    when public._mcp_card_status(r) = 'held' then
      jsonb_build_object('error', 'held', 'message', 'A buyer is holding this card (hold, accepted offer or order). Resolve it in the CardShow app first.')
    else null end
$$;

-- ── update_card ─────────────────────────────────────────────────────────────
-- p_args: {inventory_id, and any of: title, player, year, set, card_number, parallel, grader, grade, cert_number,
--          condition, location}. An empty string clears a field.
create or replace function public.mcp_update_card(p_args jsonb, p_confirm_token text default null, p_client_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:write');
  v_id uuid := public._mcp_uuid(p_args->>'inventory_id');
  r jsonb; v_block jsonb; v_changes jsonb := '[]'::jsonb; v_set jsonb := '{}'::jsonb;
  f record; v_old text; v_new text; v_state text; v_take text; v_res jsonb; v_replay jsonb;
  v_fields constant jsonb := '{"title":"card_title","player":"player","year":"year","set":"card_set","card_number":"card_number",
    "parallel":"parallel","grader":"grader","grade":"grade","cert_number":"cert_number","condition":"condition","location":"location"}';
begin
  if p_client_request_id is not null then
    v_replay := public._mcp_replay(p_client_request_id);
    if v_replay is not null then return jsonb_build_object('stage', 'applied', 'replayed', true, 'result', v_replay); end if;
  end if;
  if public._mcp_token_used(p_confirm_token) then return jsonb_build_object('error', 'token_used'); end if;
  if v_id is null then return jsonb_build_object('error', 'bad_input', 'message', 'inventory_id must be a card id from list_my_inventory.'); end if;
  if exists (select 1 from jsonb_object_keys(p_args) k where k not in ('inventory_id') and not (v_fields ? k)) then
    return jsonb_build_object('error', 'bad_input', 'message', 'Fields that can be changed: title, player, year, set, card_number, parallel, grader, grade, cert_number, condition, location.');
  end if;
  r := public._mcp_own_card(v_uid, v_id);
  v_block := public._mcp_card_blocked(r, true);
  if v_block is not null then return v_block; end if;

  for f in select k, v_fields->>k col from jsonb_object_keys(p_args) k where k <> 'inventory_id' order by k loop
    v_old := nullif(r->>f.col, '');
    v_new := nullif(trim(coalesce(p_args->>f.k, '')), '');
    if f.k = 'year' and v_new is not null and v_new !~ '^\d{4}$' then
      return jsonb_build_object('error', 'bad_input', 'message', 'year must be a 4-digit year.');
    end if;
    if f.k = 'grade' and v_new is not null and public._mcp_num(v_new) is null then
      return jsonb_build_object('error', 'bad_input', 'message', 'grade must be a number like 9.5.');
    end if;
    if f.k = 'grade' and v_new is not null and v_old is not null and public._mcp_num(v_old) = public._mcp_num(v_new) then continue; end if;
    if v_old is distinct from v_new then
      v_changes := v_changes || jsonb_build_array(jsonb_build_object('field', f.k, 'old', v_old, 'new', v_new));
      v_set := v_set || jsonb_build_object(f.col, v_new);
    end if;
  end loop;
  if jsonb_array_length(v_changes) = 0 then
    return jsonb_build_object('error', 'no_changes', 'message', 'Those values are already on the card.');
  end if;

  v_state := public._mcp_card_state(v_id);
  if p_confirm_token is null then
    return public._mcp_confirm_issue('update_card', p_args, v_state, jsonb_build_object(
      'action', 'Update card', 'card', public._mcp_card_json(r), 'changes', v_changes,
      'gtcr_recheck', (v_set ? 'cert_number' or v_set ? 'grader') and coalesce(v_set->>'cert_number', r->>'cert_number') is not null));
  end if;

  v_take := public._mcp_confirm_take('update_card', p_args, p_confirm_token, v_state);
  if v_take <> 'ok' then return jsonb_build_object('error', v_take); end if;

  perform public._mcp_update_card_cols(v_uid, v_id, v_set);

  v_res := jsonb_build_object('updated', true, 'changes', v_changes,
    'card', public._mcp_card_json(public._mcp_own_card(v_uid, v_id)),
    'gtcr_recheck', (v_set ? 'cert_number' or v_set ? 'grader') and coalesce(v_set->>'cert_number', r->>'cert_number') is not null);
  if p_client_request_id is not null then perform public._mcp_store_result('update_card', p_client_request_id, p_args, v_res); end if;
  return jsonb_build_object('stage', 'applied', 'result', v_res);
end $$;

-- ── set_price ───────────────────────────────────────────────────────────────
create or replace function public.mcp_set_price(p_args jsonb, p_confirm_token text default null, p_client_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:write');
  v_id uuid := public._mcp_uuid(p_args->>'inventory_id');
  v_cents bigint := public._mcp_num(p_args->>'price_cents')::bigint;
  r jsonb; v_block jsonb; v_old bigint; v_state text; v_take text; v_res jsonb; v_replay jsonb; v_comp bigint;
begin
  if p_client_request_id is not null then
    v_replay := public._mcp_replay(p_client_request_id);
    if v_replay is not null then return jsonb_build_object('stage', 'applied', 'replayed', true, 'result', v_replay); end if;
  end if;
  if public._mcp_token_used(p_confirm_token) then return jsonb_build_object('error', 'token_used'); end if;
  if v_id is null then return jsonb_build_object('error', 'bad_input', 'message', 'inventory_id must be a card id from list_my_inventory.'); end if;
  if v_cents is null or public._mcp_num(p_args->>'price_cents') <> v_cents or v_cents < 1 or v_cents > 100000000 then
    return jsonb_build_object('error', 'bad_input', 'message', 'price_cents must be a whole number of cents, at least 1 (e.g. 12500 for $125.00).');
  end if;
  r := public._mcp_own_card(v_uid, v_id);
  v_block := public._mcp_card_blocked(r, false);
  if v_block is not null then return v_block; end if;
  v_old := public._mcp_cents(r->>'price');
  if v_old = v_cents then return jsonb_build_object('error', 'no_changes', 'message', 'The card already has that price.'); end if;
  v_comp := case when public._mcp_comp_visible(r) then (r->>'comp_value_cents')::bigint end;

  v_state := public._mcp_card_state(v_id);
  if p_confirm_token is null then
    return public._mcp_confirm_issue('set_price', p_args, v_state, jsonb_build_object(
      'action', 'Change price', 'card', public._mcp_card_json(r),
      'old_price_cents', v_old, 'old_price', public._mcp_dollars(v_old),
      'new_price_cents', v_cents, 'new_price', public._mcp_dollars(v_cents),
      'comp_cents', v_comp, 'comp', public._mcp_dollars(v_comp),
      'new_pct_of_comp', case when v_comp > 0 then round(v_cents::numeric / v_comp, 3) end,
      'listed', r->>'listing_status' = 'active'));
  end if;
  v_take := public._mcp_confirm_take('set_price', p_args, p_confirm_token, v_state);
  if v_take <> 'ok' then return jsonb_build_object('error', v_take); end if;

  update public.inventory set price = v_cents / 100.0, updated_at = now() where id = v_id and seller_id = v_uid;
  v_res := jsonb_build_object('updated', true, 'old_price', public._mcp_dollars(v_old), 'new_price', public._mcp_dollars(v_cents),
    'card', public._mcp_card_json(public._mcp_own_card(v_uid, v_id)));
  if p_client_request_id is not null then perform public._mcp_store_result('set_price', p_client_request_id, p_args, v_res); end if;
  return jsonb_build_object('stage', 'applied', 'result', v_res);
end $$;

-- ── publish_to_show / unpublish_from_show ───────────────────────────────────
create or replace function public.mcp_show_membership(p_args jsonb, p_publish boolean, p_confirm_token text default null,
  p_client_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:write');
  v_tool text := case when p_publish then 'publish_to_show' else 'unpublish_from_show' end;
  v_id uuid := public._mcp_uuid(p_args->>'inventory_id');
  v_show text := nullif(trim(coalesce(p_args->>'show_id', '')), '');
  r jsonb; s public.shows%rowtype; v_block jsonb; v_in boolean; v_state text; v_take text; v_res jsonb; v_replay jsonb;
begin
  if p_client_request_id is not null then
    v_replay := public._mcp_replay(p_client_request_id);
    if v_replay is not null then return jsonb_build_object('stage', 'applied', 'replayed', true, 'result', v_replay); end if;
  end if;
  if public._mcp_token_used(p_confirm_token) then return jsonb_build_object('error', 'token_used'); end if;
  if v_id is null or v_show is null then
    return jsonb_build_object('error', 'bad_input', 'message', 'inventory_id and show_id are required (ids from list_my_inventory and list_my_shows).');
  end if;
  r := public._mcp_own_card(v_uid, v_id);
  if r is null then return jsonb_build_object('error', 'not_found', 'message', 'No card with that id in your inventory.'); end if;
  select * into s from public.shows where id = v_show;
  if not found then return jsonb_build_object('error', 'not_found', 'message', 'No show with that id.'); end if;
  v_in := exists (select 1 from public.show_inventory where show_id = v_show and card_id = v_id);

  if p_publish then
    v_block := public._mcp_card_blocked(r, false);
    if v_block is not null then return v_block; end if;
    if v_in then return jsonb_build_object('error', 'no_changes', 'message', 'This card is already published to that show.'); end if;
    if not exists (select 1 from public.show_sellers where show_id = v_show and seller_id = v_uid) then
      return jsonb_build_object('error', 'not_joined', 'message', 'You are not in this show. Join it in the CardShow app first.');
    end if;
    if public._mcp_show_ended(s) then return jsonb_build_object('error', 'show_ended', 'message', 'That show has ended.'); end if;
    if r->>'trust_flag' = 'flagged' then
      return jsonb_build_object('error', 'gtcr_flagged', 'message', 'This card has a stolen or lost report in GTCR and can''t be published. Review it in the CardShow app.');
    end if;
    if r->>'identification_status' = 'unidentified' then
      return jsonb_build_object('error', 'needs_details', 'message', 'Add this card''s details first (it was logged without them).');
    end if;
  elsif not v_in then
    return jsonb_build_object('error', 'no_changes', 'message', 'This card is not published to that show.');
  end if;

  v_state := public._mcp_card_state(v_id);
  if p_confirm_token is null then
    return public._mcp_confirm_issue(v_tool, p_args, v_state, jsonb_build_object(
      'action', case when p_publish then 'Publish card to show' else 'Take card off show' end,
      'card', public._mcp_card_json(r),
      'show', jsonb_build_object('id', s.id, 'name', s.name, 'start_date', s.start_date, 'end_date', coalesce(s.end_date, s.start_date),
                                 'city', s.city, 'state', s.state),
      'note', case when p_publish then 'Buyers at this show will see the card. Graded cards get a stolen/lost check first.'
                   else 'Buyers at this show will no longer see the card. The card stays in your inventory.' end));
  end if;
  v_take := public._mcp_confirm_take(v_tool, p_args, p_confirm_token, v_state);
  if v_take <> 'ok' then return jsonb_build_object('error', v_take); end if;

  if p_publish then
    insert into public.show_inventory (show_id, card_id) values (v_show, v_id) on conflict do nothing;
  else
    delete from public.show_inventory where show_id = v_show and card_id = v_id;
  end if;
  v_res := jsonb_build_object(case when p_publish then 'published' else 'unpublished' end, true, 'show_id', v_show, 'show_name', s.name,
    'card', public._mcp_card_json(public._mcp_own_card(v_uid, v_id)),
    'gtcr_recheck', p_publish and public._mcp_is_graded(r) and nullif(r->>'cert_number', '') is not null);
  if p_client_request_id is not null then perform public._mcp_store_result(v_tool, p_client_request_id, p_args, v_res); end if;
  return jsonb_build_object('stage', 'applied', 'result', v_res);
end $$;

create or replace function public.mcp_publish_to_show(p_args jsonb, p_confirm_token text default null, p_client_request_id uuid default null)
returns jsonb language sql security invoker set search_path = public as $$
  select public.mcp_show_membership(p_args, true, p_confirm_token, p_client_request_id) $$;
create or replace function public.mcp_unpublish_from_show(p_args jsonb, p_confirm_token text default null, p_client_request_id uuid default null)
returns jsonb language sql security invoker set search_path = public as $$
  select public.mcp_show_membership(p_args, false, p_confirm_token, p_client_request_id) $$;

-- ── record_sale ─────────────────────────────────────────────────────────────
-- p_args: {inventory_id | description, sale_price_cents, payment_method, show_id?, buyer_note?, sold_at?}
-- p_client_request_id is required (also the sale's client_sale_id, so record_sale() itself can't double it).
create or replace function public.mcp_record_sale(p_args jsonb, p_confirm_token text default null, p_client_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('sales:write');
  v_id uuid := public._mcp_uuid(p_args->>'inventory_id');
  v_desc text := nullif(trim(coalesce(p_args->>'description', '')), '');
  v_cents bigint := public._mcp_num(p_args->>'sale_price_cents')::bigint;
  v_pay text := lower(trim(coalesce(p_args->>'payment_method', '')));
  v_payment text; v_show text := nullif(trim(coalesce(p_args->>'show_id', '')), '');
  v_note text := left(nullif(trim(coalesce(p_args->>'buyer_note', '')), ''), 500);
  v_sold_at timestamptz; v_tz text; r jsonb; v_block jsonb; s public.shows%rowtype; v_found jsonb;
  v_state text; v_take text; v_res jsonb; v_replay jsonb; v_sale jsonb; v_seller record; v_table text; v_cost numeric;
  v_show_auto boolean := false;
begin
  if p_client_request_id is null then
    return jsonb_build_object('error', 'bad_input', 'message', 'client_request_id is required: a new UUID for this sale, reused if you retry it.');
  end if;
  v_replay := public._mcp_replay(p_client_request_id);
  if v_replay is not null then return jsonb_build_object('stage', 'applied', 'replayed', true, 'result', v_replay); end if;
  if public._mcp_token_used(p_confirm_token) then return jsonb_build_object('error', 'token_used'); end if;

  if v_cents is null or public._mcp_num(p_args->>'sale_price_cents') <> v_cents or v_cents < 0 or v_cents > 100000000 then
    return jsonb_build_object('error', 'bad_input', 'message', 'sale_price_cents must be a whole number of cents (e.g. 12500 for $125.00).');
  end if;
  v_payment := case v_pay when 'cash' then 'Cash' when 'venmo' then 'Venmo' when 'paypal' then 'PayPal' when 'zelle' then 'Zelle'
    when 'card' then 'Card' when 'square' then 'Square' when 'other' then 'Other' end;
  if v_payment is null then
    return jsonb_build_object('error', 'bad_input', 'message', 'payment_method must be cash, venmo, paypal, zelle, card, square or other. Trades are logged in the CardShow app.');
  end if;
  begin
    v_sold_at := coalesce(nullif(p_args->>'sold_at', '')::timestamptz, now());
  exception when others then
    return jsonb_build_object('error', 'bad_input', 'message', 'sold_at must be a date/time like 2026-11-26T14:30:00-08:00.');
  end;
  if v_sold_at > now() + interval '5 minutes' or v_sold_at < now() - interval '1 year' then
    return jsonb_build_object('error', 'bad_input', 'message', 'sold_at must be within the last year and not in the future.');
  end if;

  -- Which card: by id, or a description that must match exactly one unsold card.
  if v_id is null then
    if v_desc is null then
      return jsonb_build_object('error', 'bad_input', 'message', 'Give inventory_id, or a description of the card (e.g. "S12" or "Wemby PSA 10").');
    end if;
    v_found := public.mcp_my_inventory(jsonb_build_object('text', v_desc, 'status', 'available', 'limit', 10));
    if (v_found->>'total')::int = 0 then
      return jsonb_build_object('error', 'not_found', 'message', 'No unsold card in your inventory matches that description.');
    elsif (v_found->>'total')::int > 1 then
      return jsonb_build_object('error', 'ambiguous', 'message', 'More than one card matches. Ask the dealer which one, then call again with its inventory_id.',
        'candidates', (select jsonb_agg(jsonb_build_object('inventory_id', c->>'id', 'title', c->>'title', 'stock_code', c->>'stock_code',
                         'grade', concat_ws(' ', c->>'grader', c->>'grade'), 'price', c->>'price'))
                         from jsonb_array_elements(v_found->'results') c), 'total', (v_found->>'total')::int);
    end if;
    v_id := (v_found->'results'->0->>'id')::uuid;
  end if;

  r := public._mcp_own_card(v_uid, v_id);
  v_block := public._mcp_card_blocked(r, false);
  if v_block is not null then return v_block; end if;
  if public._mcp_open_offers(v_id) > 0 then
    return jsonb_build_object('error', 'open_offer', 'message', 'A buyer has an open offer on this card. Answer it in the CardShow app first.');
  end if;

  -- The show: as given (must be one the card or dealer is in), else the card's one show running today.
  if v_show is not null then
    select * into s from public.shows where id = v_show;
    if not found then return jsonb_build_object('error', 'not_found', 'message', 'No show with that id.'); end if;
    if not exists (select 1 from public.show_sellers where show_id = v_show and seller_id = v_uid)
       and not exists (select 1 from public.show_inventory where show_id = v_show and card_id = v_id) then
      return jsonb_build_object('error', 'not_joined', 'message', 'You are not in that show.');
    end if;
  else
    select sh.* into s from public.show_inventory si join public.shows sh on sh.id = si.show_id
     where si.card_id = v_id and (v_sold_at at time zone coalesce(to_jsonb(sh)->>'timezone', 'America/Los_Angeles'))::date
           between sh.start_date and coalesce(sh.end_date, sh.start_date)
     limit 2;
    if found and (select count(*) from public.show_inventory si join public.shows sh on sh.id = si.show_id
                   where si.card_id = v_id and (v_sold_at at time zone coalesce(to_jsonb(sh)->>'timezone', 'America/Los_Angeles'))::date
                         between sh.start_date and coalesce(sh.end_date, sh.start_date)) = 1 then
      v_show := s.id; v_show_auto := true;
    else
      s := null;
    end if;
  end if;
  v_tz := coalesce(to_jsonb(s)->>'timezone', 'America/Los_Angeles');

  v_state := public._mcp_card_state(v_id);
  if p_confirm_token is null then
    return public._mcp_confirm_issue('record_sale', p_args, v_state, jsonb_build_object(
      'action', 'Record sale', 'card', public._mcp_card_json(r),
      'asking_price_cents', public._mcp_cents(r->>'price'), 'asking_price', public._mcp_dollars(public._mcp_cents(r->>'price')),
      'sale_price_cents', v_cents, 'sale_price', public._mcp_dollars(v_cents),
      'payment_method', v_payment, 'sold_at', v_sold_at,
      'show', case when v_show is null then null else jsonb_build_object('id', s.id, 'name', s.name, 'picked_automatically', v_show_auto) end,
      'show_note', case when v_show is null then 'Recorded as an off-show sale.' end,
      'buyer_note', v_note,
      'last_copy', true, 'quantity_note', 'Each card is one item in CardShow; this marks it sold.'));
  end if;
  v_take := public._mcp_confirm_take('record_sale', p_args, p_confirm_token, v_state);
  if v_take <> 'ok' then return jsonb_build_object('error', v_take); end if;

  -- The same path the app's Show Mode uses: inventory marked sold, sales row, show membership.
  v_sale := public.record_sale(p_client_request_id, v_id, null, v_show, v_cents / 100.0, v_payment, null,
    to_char(v_sold_at at time zone v_tz, 'YYYY-MM-DD'), trim(to_char(v_sold_at at time zone v_tz, 'FMHH12:MI AM')), null, 'agent');
  if v_sale ? 'error' then return jsonb_build_object('error', v_sale->>'error', 'message', 'This card was already sold.'); end if;
  if v_note is not null then
    perform public._mcp_update_card_cols(v_uid, v_id, jsonb_build_object('sale_notes', v_note));
  end if;

  -- The show-floor ledger row (the app writes it from the phone; here it's written in the same transaction).
  if v_show is not null then
    select handle into v_seller from public.sellers where id = v_uid;
    select table_number into v_table from public.show_sellers where show_id = v_show and seller_id = v_uid limit 1;
    perform public._mcp_insert_existing('show_floor_transactions', jsonb_strip_nulls(jsonb_build_object(
      'sold_at', v_sold_at, 'sold_price', v_cents / 100.0, 'asking_price', public._mcp_num(r->>'price'),
      'payment_method', v_payment, 'source', 'agent', 'txn_type', 'sale', 'client_sale_id', p_client_request_id,
      'inventory_id', v_id, 'card_title', r->>'card_title', 'player', r->>'player', 'year', public._mcp_num(r->>'year')::int,
      'card_set', r->>'card_set', 'card_number', r->>'card_number', 'parallel', r->>'parallel', 'grader', nullif(r->>'grader', ''),
      'grade', public._mcp_num(r->>'grade'), 'cert_number', nullif(r->>'cert_number', ''), 'condition', r->>'condition',
      'item_type', coalesce(r->>'item_type', 'card'), 'category', r->>'category', 'subcategory', r->>'subcategory',
      'seller_id', v_uid, 'seller_handle', v_seller.handle, 'show_id', v_show, 'show_name', s.name,
      'show_date', s.start_date, 'show_location', s.location, 'show_city', s.city, 'show_state', s.state,
      'table_number', v_table, 'is_test', false, 'api_eligible', true, 'data_version', 1)));
  end if;

  -- Private cost copy for profit (owner-only table).
  if to_regclass('public.inventory_costs') is not null and to_regclass('public.transaction_costs') is not null then
    execute 'select cost_basis from public.inventory_costs where inventory_id = $1' into v_cost using v_id;
    if v_cost is not null then
      execute 'insert into public.transaction_costs (client_sale_id, inventory_id, show_id, sale_price, cost_at_sale, sold_at)
               values ($1, $2, $3, $4, $5, $6) on conflict (client_sale_id) do nothing'
        using p_client_request_id, v_id, v_show, v_cents / 100.0, v_cost, v_sold_at;
    end if;
  end if;

  v_res := jsonb_build_object('recorded', true, 'sale_id', v_sale->>'sale_id', 'client_request_id', p_client_request_id,
    'card', public._mcp_card_json(public._mcp_own_card(v_uid, v_id)),
    'sale_price', public._mcp_dollars(v_cents), 'sale_price_cents', v_cents, 'payment_method', v_payment, 'sold_at', v_sold_at,
    'show', case when v_show is null then null else jsonb_build_object('id', v_show, 'name', s.name) end,
    'profit', case when v_cost is not null then public._mcp_dollars(v_cents - round(v_cost * 100)::bigint) end,
    'undo', 'Undo within 10 minutes in the CardShow app (Show Mode → Recent sales).');
  perform public._mcp_store_result('record_sale', p_client_request_id, p_args, v_res);
  return jsonb_build_object('stage', 'applied', 'result', v_res);
end $$;

revoke all on function public.mcp_update_card(jsonb, text, uuid), public.mcp_set_price(jsonb, text, uuid),
  public.mcp_show_membership(jsonb, boolean, text, uuid), public.mcp_publish_to_show(jsonb, text, uuid),
  public.mcp_unpublish_from_show(jsonb, text, uuid), public.mcp_record_sale(jsonb, text, uuid) from public, anon;
grant execute on function public.mcp_update_card(jsonb, text, uuid), public.mcp_set_price(jsonb, text, uuid),
  public.mcp_show_membership(jsonb, boolean, text, uuid), public.mcp_publish_to_show(jsonb, text, uuid),
  public.mcp_unpublish_from_show(jsonb, text, uuid), public.mcp_record_sale(jsonb, text, uuid) to authenticated;

-- Check after running:
--   select count(*) from pg_proc where proname in ('mcp_update_card','mcp_set_price','mcp_publish_to_show',
--     'mcp_unpublish_from_show','mcp_record_sale','mcp_show_membership');   -- 6
