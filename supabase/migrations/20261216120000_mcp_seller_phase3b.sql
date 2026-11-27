-- Seller MCP server, Phase 3b: cards from a photo shared in the chat. Run after 20261215120000_mcp_seller_phase3.sql.
-- Re-runnable.
--
-- An assistant can see a photo the dealer drops into the chat but can't pass the file to a tool. So:
--   mcp_add_cards          the assistant sends the details it read itself (with the fields it isn't sure of);
--                          preview → confirm, like every write. The result carries a short-lived photo link
--                          (getcardshow.com/photo/<code>) where the dealer attaches the real photo to each new card.
--   mcp_photo_upload_link  a photo link where the dealer uploads photos from their phone into a photo batch; after
--                          "Send to Claude" they're read by the usual scan-card reader and the assistant confirms them
--                          with add_cards_from_photos (job_id).
-- Links: 10-character code (stored hashed), 30 minutes, only the dealer's own cards / batch. The link page talks to
-- netlify/functions/photo-link.js (service key), never to the database directly.

-- ── photo links ─────────────────────────────────────────────────────────────
alter table public.mcp_photo_jobs drop constraint if exists mcp_photo_jobs_status_check;
alter table public.mcp_photo_jobs add constraint mcp_photo_jobs_status_check check (status in ('collecting', 'working', 'done', 'applied'));

create table if not exists public.mcp_photo_links (
  id            uuid primary key default gen_random_uuid(),
  code_hash     text not null unique,
  owner_id      uuid not null,
  client_id     text,
  kind          text not null check (kind in ('attach', 'scan')),
  inventory_ids uuid[] not null default '{}',
  job_id        uuid references public.mcp_photo_jobs(id) on delete cascade,
  uploads       integer not null default 0,
  expires_at    timestamptz not null,
  finished_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists mcp_photo_links_owner_idx on public.mcp_photo_links (owner_id, created_at desc);
alter table public.mcp_photo_links enable row level security;
revoke all on public.mcp_photo_links from anon, authenticated;
grant all on public.mcp_photo_links to service_role;

-- New link for the calling dealer. Returns the code (the only time it exists in clear).
create or replace function public._mcp_photo_link_create(p_kind text, p_ids uuid[], p_job uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public._mcp_require(null);
  v_abc constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := decode(md5(gen_random_uuid()::text || clock_timestamp()::text), 'hex');
  v_code text := ''; i int; v_exp timestamptz := now() + interval '30 minutes';
begin
  for i in 0..9 loop v_code := v_code || substr(v_abc, 1 + (get_byte(v_bytes, i) % length(v_abc)), 1); end loop;
  delete from public.mcp_photo_links where owner_id = v_uid and expires_at < now() - interval '1 day';
  insert into public.mcp_photo_links (code_hash, owner_id, client_id, kind, inventory_ids, job_id, expires_at)
  values (public._mcp_token_hash(v_code), v_uid, public._mcp_client_id(), p_kind, coalesce(p_ids, '{}'), p_job, v_exp);
  return jsonb_build_object('code', v_code, 'expires_at', v_exp);
end $$;
revoke all on function public._mcp_photo_link_create(text, uuid[], uuid) from public, anon;
grant execute on function public._mcp_photo_link_create(text, uuid[], uuid) to authenticated;

-- p_args: {} → a photo batch waiting for the dealer's uploads + its link.
create or replace function public.mcp_photo_upload_link(p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._mcp_require('inventory:write'); v_job uuid; v_link jsonb;
begin
  if (select count(*) from public.mcp_photo_links where owner_id = v_uid and created_at > now() - interval '1 day') >= 50 then
    return jsonb_build_object('error', 'daily_limit', 'message', 'That is more than 50 photo links today. Try again tomorrow.');
  end if;
  insert into public.mcp_photo_jobs (owner_id, client_id, status, images) values (v_uid, public._mcp_client_id(), 'collecting', '[]')
  returning id into v_job;
  v_link := public._mcp_photo_link_create('scan', null, v_job);
  return jsonb_build_object('job_id', v_job, 'code', v_link->>'code', 'expires_at', v_link->'expires_at');
end $$;
revoke all on function public.mcp_photo_upload_link(jsonb) from public, anon;
grant execute on function public.mcp_photo_upload_link(jsonb) to authenticated;

-- ── add_cards (details the assistant read) ──────────────────────────────────
-- One card from the assistant's input. Returns {draft} or {error}.
create or replace function public._mcp_typed_draft(o jsonb, n int) returns jsonb
language plpgsql immutable as $$
declare
  v_player text := nullif(trim(coalesce(o->>'player', '')), '');
  v_year text := nullif(trim(coalesce(o->>'year', '')), '');
  v_set text := nullif(trim(coalesce(o->>'set', '')), '');
  v_num text := nullif(trim(coalesce(o->>'card_number', '')), '');
  v_par text := nullif(trim(coalesce(o->>'parallel', '')), '');
  v_grader text := nullif(trim(coalesce(o->>'grader', '')), '');
  v_grade text := nullif(trim(coalesce(o->>'grade', '')), '');
  v_cert text := nullif(trim(coalesce(o->>'cert_number', '')), '');
  v_title text := nullif(trim(coalesce(o->>'title', '')), '');
  v_cond text := nullif(trim(coalesce(o->>'condition', '')), '');
  v_serial text := nullif(trim(coalesce(o->>'serial_number', '')), '');
  v_run text := nullif(trim(coalesce(o->>'print_run_size', '')), '');
  v_price numeric := public._mcp_num(o->>'price_cents');
  v_feat text[] := '{}'; v_unsure text[] := '{}'; f text;
  v_vocab constant text[] := array['RC','Auto','Relic/Memorabilia','Patch','Refractor','1st Edition','Short Print'];
  v_fields constant text[] := array['title','player','year','set','card_number','parallel','grader','grade','cert_number','condition','serial_number','print_run_size','features'];
begin
  if jsonb_typeof(o) <> 'object' then return jsonb_build_object('error', format('Card %s: send an object with the card''s details.', n)); end if;
  if v_grader ~* '^(raw|ungraded|none)$' then v_grader := null; end if;
  if v_grader is null then v_grade := null; v_cert := null; end if;
  if v_year is not null and v_year !~ '^\d{4}$' then return jsonb_build_object('error', format('Card %s: year must be 4 digits.', n)); end if;
  if v_grade is not null and public._mcp_num(v_grade) is null then return jsonb_build_object('error', format('Card %s: grade must be a number like 9.5.', n)); end if;
  if v_run is not null and v_run !~ '^\d{1,6}$' then return jsonb_build_object('error', format('Card %s: print_run_size must be a whole number.', n)); end if;
  if o ? 'price_cents' and (v_price is null or v_price < 0 or v_price <> trunc(v_price) or v_price > 100000000) then
    return jsonb_build_object('error', format('Card %s: price_cents must be a whole number of cents.', n));
  end if;
  if v_player is null and v_title is null then return jsonb_build_object('error', format('Card %s: give at least the player (or a title).', n)); end if;
  if jsonb_typeof(o->'features') = 'array' then
    for f in select value from jsonb_array_elements_text(o->'features') loop
      f := (select v from unnest(v_vocab) v where lower(v) = lower(trim(f)) limit 1);
      if f is null then return jsonb_build_object('error', format('Card %s: features can be %s.', n, array_to_string(v_vocab, ', '))); end if;
      if not f = any(v_feat) then v_feat := v_feat || f; end if;
    end loop;
  end if;
  if jsonb_typeof(o->'unsure_fields') = 'array' then
    for f in select value from jsonb_array_elements_text(o->'unsure_fields') loop
      if f = any(v_fields) and not f = any(v_unsure) then v_unsure := v_unsure || f; end if;
    end loop;
  end if;
  if v_player is null and not 'player' = any(v_unsure) then v_unsure := v_unsure || 'player'; end if;
  v_title := coalesce(v_title, nullif(concat_ws(' ', v_year, v_set, v_player, v_par,
    case when 'Auto' = any(v_feat) and coalesce(v_par, '') !~* 'auto' then 'Auto' end), ''));
  return jsonb_build_object('draft', jsonb_strip_nulls(jsonb_build_object('index', n, 'title', v_title, 'player', v_player,
    'year', v_year, 'set', v_set, 'card_number', v_num, 'parallel', v_par, 'grader', v_grader, 'grade', v_grade,
    'cert_number', v_cert, 'condition', v_cond, 'serial_number', v_serial, 'print_run_size', v_run,
    'features', case when cardinality(v_feat) > 0 then to_jsonb(v_feat) end,
    'price_cents', coalesce(v_price, 0)::bigint, 'price', public._mcp_dollars(coalesce(v_price, 0)),
    'check_fields', to_jsonb(v_unsure), 'low_confidence', cardinality(v_unsure) > 0)));
end $$;

-- p_args: {cards: [{player, year, set, card_number, parallel, grader, grade, cert_number, title, condition,
--          serial_number, print_run_size, features[], price_cents, unsure_fields[], include}], show_id?: id | 'none'}
-- client_request_id is required.
create or replace function public.mcp_add_cards(p_args jsonb, p_confirm_token text default null, p_client_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:write');
  v_cards jsonb := p_args->'cards';
  v_show text := nullif(trim(coalesce(p_args->>'show_id', '')), ''); s public.shows%rowtype; v_show_auto boolean := false;
  o jsonb; r jsonb; d jsonb; n int := 0; v_dup uuid; v_include boolean;
  v_drafts jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb; v_low int;
  v_state text; v_take text; v_res jsonb; v_replay jsonb; v_ids uuid[] := '{}'; v_id uuid; v_gtcr uuid[] := '{}';
  v_created jsonb; v_link jsonb; v_src_ok boolean;
begin
  if p_client_request_id is null then
    return jsonb_build_object('error', 'bad_input', 'message', 'client_request_id is required: a new UUID for these cards, reused if you retry.');
  end if;
  v_replay := public._mcp_replay(p_client_request_id);
  if v_replay is not null then return jsonb_build_object('stage', 'applied', 'replayed', true, 'result', v_replay); end if;
  if public._mcp_token_used(p_confirm_token) then return jsonb_build_object('error', 'token_used'); end if;
  if jsonb_typeof(v_cards) <> 'array' or jsonb_array_length(v_cards) = 0 then
    return jsonb_build_object('error', 'bad_input', 'message', 'cards is required: 1 to 20 cards with the details you read.');
  end if;
  if jsonb_array_length(v_cards) > 20 then
    return jsonb_build_object('error', 'bad_input', 'message', 'At most 20 cards per call. Send the rest in another call.');
  end if;

  if v_show = 'none' then v_show := null;
  elsif v_show is not null then
    select * into s from public.shows where id = v_show;
    if not found then return jsonb_build_object('error', 'not_found', 'message', 'No show with that id.'); end if;
    if not exists (select 1 from public.show_sellers where show_id = v_show and seller_id = v_uid) then
      return jsonb_build_object('error', 'not_joined', 'message', 'You are not in that show. Join it in the CardShow app first.');
    end if;
    if public._mcp_show_ended(s) then return jsonb_build_object('error', 'show_ended', 'message', 'That show has ended.'); end if;
  else
    select sh.* into s from public.show_sellers ss join public.shows sh on sh.id = ss.show_id
     where ss.seller_id = v_uid and (now() at time zone coalesce(to_jsonb(sh)->>'timezone', 'America/Los_Angeles'))::date
           between sh.start_date and coalesce(sh.end_date, sh.start_date);
    if found and (select count(*) from public.show_sellers ss join public.shows sh on sh.id = ss.show_id
                   where ss.seller_id = v_uid and (now() at time zone coalesce(to_jsonb(sh)->>'timezone', 'America/Los_Angeles'))::date
                         between sh.start_date and coalesce(sh.end_date, sh.start_date)) = 1 then
      v_show := s.id; v_show_auto := true;
    else s := null; end if;
  end if;

  for o in select value from jsonb_array_elements(v_cards) loop
    n := n + 1;
    r := public._mcp_typed_draft(o, n);
    if r ? 'error' then return jsonb_build_object('error', 'bad_input', 'message', r->>'error'); end if;
    d := r->'draft';
    v_dup := null;
    if d->>'cert_number' is not null then
      select i.id into v_dup from public.inventory i
       where i.seller_id = v_uid and i.cert_number = d->>'cert_number' and coalesce(i.status, '') <> 'Sold'
         and (i.grader is null or upper(i.grader) = upper(d->>'grader')) limit 1;
    end if;
    v_include := coalesce((o->>'include')::boolean, v_dup is null);
    if v_dup is not null then
      d := d || jsonb_build_object('duplicate_of', v_dup, 'duplicate_note', 'This cert is already in your inventory; skipped unless include is true.');
    end if;
    if v_include then v_drafts := v_drafts || jsonb_build_array(d); else v_skipped := v_skipped || jsonb_build_array(d); end if;
  end loop;
  if jsonb_array_length(v_drafts) = 0 then
    return jsonb_build_object('error', 'no_changes', 'message', 'No cards to add.', 'skipped', v_skipped);
  end if;
  select count(*) into v_low from jsonb_array_elements(v_drafts) x where (x->>'low_confidence')::boolean;

  v_state := md5(v_drafts::text || coalesce(v_show, ''));
  if p_confirm_token is null then
    return public._mcp_confirm_issue('add_cards', p_args, v_state, jsonb_strip_nulls(jsonb_build_object(
      'action', 'Add cards', 'cards', v_drafts, 'count', jsonb_array_length(v_drafts), 'need_a_check', v_low,
      'check_note', case when v_low > 0 then format('%s card(s) have fields marked unsure (check_fields). Ask the dealer about those and send the corrected values before confirming.', v_low) end,
      'skipped', case when jsonb_array_length(v_skipped) > 0 then v_skipped end,
      'show', case when v_show is not null then jsonb_build_object('id', s.id, 'name', s.name, 'chosen_automatically', v_show_auto) end,
      'note', 'Cards are added as available. After adding, you get a link where the dealer can attach each card''s photo (needed to list a graded card online).')));
  end if;
  v_take := public._mcp_confirm_take('add_cards', p_args, p_confirm_token, v_state);
  if v_take <> 'ok' then return jsonb_build_object('error', v_take); end if;

  v_src_ok := not exists (select 1 from pg_constraint where conrelid = 'public.inventory'::regclass and contype = 'c'
                            and pg_get_constraintdef(oid) ~ '\msource\M' and pg_get_constraintdef(oid) !~ 'agent');
  for d in select value from jsonb_array_elements(v_drafts) loop
    v_id := gen_random_uuid();
    perform public._mcp_insert_existing('inventory', jsonb_strip_nulls(jsonb_build_object(
      'id', v_id, 'seller_id', v_uid, 'card_title', coalesce(d->>'title', ''), 'player', d->>'player',
      'year', d->>'year', 'card_set', d->>'set', 'card_number', d->>'card_number', 'parallel', d->>'parallel',
      'grader', d->>'grader', 'grade', d->>'grade', 'cert_number', d->>'cert_number', 'condition', d->>'condition',
      'serial_number', d->>'serial_number', 'print_run_size', d->>'print_run_size', 'features', d->'features',
      'price', (d->>'price_cents')::numeric / 100, 'status', 'Available', 'item_type', 'card',
      'source', case when v_src_ok then 'agent' end)));
    if v_show is not null then
      insert into public.show_inventory (show_id, card_id) values (v_show, v_id) on conflict do nothing;
    end if;
    v_ids := v_ids || v_id;
    if d->>'grader' is not null and d->>'cert_number' is not null then v_gtcr := v_gtcr || v_id; end if;
  end loop;
  if to_regprocedure('public.assign_stock_codes(uuid[])') is not null then
    execute 'select public.assign_stock_codes($1)' using v_ids;
  end if;
  v_link := public._mcp_photo_link_create('attach', v_ids, null);

  select coalesce(jsonb_agg(public._mcp_card_json(to_jsonb(i)) order by array_position(v_ids, i.id)), '[]'::jsonb) into v_created
    from public.inventory i where i.id = any(v_ids) and i.seller_id = v_uid;
  v_res := jsonb_strip_nulls(jsonb_build_object('added', cardinality(v_ids), 'cards', v_created,
    'published_to', case when v_show is not null then jsonb_build_object('id', s.id, 'name', s.name) end,
    'photo_link_code', v_link->>'code', 'photo_link_expires_at', v_link->'expires_at',
    'gtcr_recheck_ids', case when cardinality(v_gtcr) > 0 then to_jsonb(v_gtcr) end));
  perform public._mcp_store_result('add_cards', p_client_request_id, p_args, v_res);
  return jsonb_build_object('stage', 'applied', 'result', v_res);
end $$;

-- ── add_cards_from_photos: a batch still collecting photos on a photo link ──
create or replace function public.mcp_add_cards_from_photos(p_args jsonb, p_confirm_token text default null,
  p_client_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:write');
  v_job uuid := public._mcp_uuid(p_args->>'job_id');
  j public.mcp_photo_jobs%rowtype;
  v_opts jsonb := coalesce(p_args->'cards', '[]'::jsonb);
  v_show text := nullif(trim(coalesce(p_args->>'show_id', '')), ''); s public.shows%rowtype; v_show_auto boolean := false;
  e jsonb; o jsonb; d jsonb; v_drafts jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb; v_failed jsonb := '[]'::jsonb;
  v_dup uuid; v_price bigint; v_include boolean; v_state text; v_take text; v_res jsonb; v_replay jsonb;
  v_ids uuid[] := '{}'; v_id uuid; v_created jsonb := '[]'::jsonb; v_gtcr uuid[] := '{}'; v_waiting int; v_low int;
  v_src_ok boolean;
begin
  if p_client_request_id is null then
    return jsonb_build_object('error', 'bad_input', 'message', 'client_request_id is required: a new UUID for this batch, reused if you retry it.');
  end if;
  v_replay := public._mcp_replay(p_client_request_id);
  if v_replay is not null then return jsonb_build_object('stage', 'applied', 'replayed', true, 'result', v_replay); end if;
  if public._mcp_token_used(p_confirm_token) then return jsonb_build_object('error', 'token_used'); end if;
  if v_job is null then return jsonb_build_object('error', 'bad_input', 'message', 'job_id must be the id returned when the photos were sent.'); end if;
  select * into j from public.mcp_photo_jobs where id = v_job and owner_id = v_uid;
  if not found then return jsonb_build_object('error', 'not_found', 'message', 'No photo batch with that id.'); end if;
  if j.status = 'applied' then return jsonb_build_object('error', 'already_added', 'message', 'The cards from this batch were already added.'); end if;
  if j.status = 'collecting' then
    return jsonb_build_object('stage', 'working', 'job_id', j.id, 'photos', jsonb_array_length(j.images), 'read', 0,
      'stale', false, 'waiting_for_upload', true,
      'next', format('Waiting for the dealer to add photos on the photo link (%s so far) and tap "Send to Claude". Ask them, then call again with the same job_id.',
                     jsonb_array_length(j.images)));
  end if;
  if j.status = 'working' then
    select count(*) into v_waiting from jsonb_array_elements(j.images) x where x->>'status' = 'waiting';
    return jsonb_build_object('stage', 'working', 'job_id', j.id, 'photos', jsonb_array_length(j.images),
      'read', jsonb_array_length(j.images) - v_waiting, 'stale', j.updated_at < now() - interval '75 seconds',
      'next', 'The photos are still being read. Call again with the same job_id in about 20 seconds.');
  end if;
  if jsonb_typeof(v_opts) <> 'array' then return jsonb_build_object('error', 'bad_input', 'message', 'cards must be a list.'); end if;

  -- The show: as given, 'none', or the one show the dealer joined that runs today (like the app's active show).
  if v_show = 'none' then v_show := null;
  elsif v_show is not null then
    select * into s from public.shows where id = v_show;
    if not found then return jsonb_build_object('error', 'not_found', 'message', 'No show with that id.'); end if;
    if not exists (select 1 from public.show_sellers where show_id = v_show and seller_id = v_uid) then
      return jsonb_build_object('error', 'not_joined', 'message', 'You are not in that show. Join it in the CardShow app first.');
    end if;
    if public._mcp_show_ended(s) then return jsonb_build_object('error', 'show_ended', 'message', 'That show has ended.'); end if;
  else
    select sh.* into s from public.show_sellers ss join public.shows sh on sh.id = ss.show_id
     where ss.seller_id = v_uid and (now() at time zone coalesce(to_jsonb(sh)->>'timezone', 'America/Los_Angeles'))::date
           between sh.start_date and coalesce(sh.end_date, sh.start_date);
    if found and (select count(*) from public.show_sellers ss join public.shows sh on sh.id = ss.show_id
                   where ss.seller_id = v_uid and (now() at time zone coalesce(to_jsonb(sh)->>'timezone', 'America/Los_Angeles'))::date
                         between sh.start_date and coalesce(sh.end_date, sh.start_date)) = 1 then
      v_show := s.id; v_show_auto := true;
    else s := null; end if;
  end if;

  for e in select value from jsonb_array_elements(j.images) order by (value->>'n')::int loop
    o := null;
    select value into o from jsonb_array_elements(v_opts) where (value->>'index')::int = (e->>'n')::int limit 1;
    if e->>'status' <> 'done' or e->'card' is null then
      v_failed := v_failed || jsonb_build_array(jsonb_build_object('index', (e->>'n')::int,
        'reason', coalesce(e->>'error', 'Couldn''t read this photo')));
      continue;
    end if;
    if o is not null and o ? 'year' and nullif(o->>'year', '') is not null and o->>'year' !~ '^\d{4}$' then
      return jsonb_build_object('error', 'bad_input', 'message', format('Card %s: year must be 4 digits.', e->>'n'));
    end if;
    if o is not null and nullif(o->>'grade', '') is not null and public._mcp_num(o->>'grade') is null then
      return jsonb_build_object('error', 'bad_input', 'message', format('Card %s: grade must be a number like 9.5.', e->>'n'));
    end if;
    v_price := case when o ? 'price_cents' then public._mcp_num(o->>'price_cents')::bigint end;
    if o ? 'price_cents' and (v_price is null or v_price < 0 or v_price > 100000000 or public._mcp_num(o->>'price_cents') <> v_price) then
      return jsonb_build_object('error', 'bad_input', 'message', format('Card %s: price_cents must be a whole number of cents.', e->>'n'));
    end if;
    d := public._mcp_photo_draft(e, o);
    if d->>'player' is null and d->>'title' is null then
      v_failed := v_failed || jsonb_build_array(jsonb_build_object('index', (e->>'n')::int, 'reason', 'No card could be read in this photo'));
      continue;
    end if;
    v_dup := null;
    if d->>'cert_number' is not null then
      select i.id into v_dup from public.inventory i
       where i.seller_id = v_uid and i.cert_number = d->>'cert_number' and coalesce(i.status, '') <> 'Sold'
         and (i.grader is null or upper(i.grader) = upper(d->>'grader')) limit 1;
    end if;
    v_include := coalesce((o->>'include')::boolean, v_dup is null);
    d := d || jsonb_strip_nulls(jsonb_build_object('price_cents', coalesce(v_price, 0), 'price', public._mcp_dollars(coalesce(v_price, 0)),
      'duplicate_of', v_dup, 'duplicate_note', case when v_dup is not null then 'This cert is already in your inventory; skipped unless you include it.' end));
    if v_include then v_drafts := v_drafts || jsonb_build_array(d);
    else v_skipped := v_skipped || jsonb_build_array(d); end if;
  end loop;
  if jsonb_array_length(v_drafts) = 0 then
    return jsonb_build_object('error', 'no_changes', 'message', 'No cards to add from these photos.', 'could_not_read', v_failed, 'skipped', v_skipped);
  end if;
  select count(*) into v_low from jsonb_array_elements(v_drafts) x where (x->>'low_confidence')::boolean;

  v_state := md5(j.updated_at::text || j.images::text || v_drafts::text);
  if p_confirm_token is null then
    return public._mcp_confirm_issue('add_cards_from_photos', p_args, v_state, jsonb_strip_nulls(jsonb_build_object(
      'action', 'Add cards from photos', 'job_id', j.id,
      'cards', v_drafts, 'count', jsonb_array_length(v_drafts),
      'need_a_check', v_low,
      'check_note', case when v_low > 0 then format('%s card(s) have fields the scan wasn''t sure about (check_fields). Read them to the dealer and fix them with cards[].<field> before confirming.', v_low) end,
      'skipped', case when jsonb_array_length(v_skipped) > 0 then v_skipped end,
      'could_not_read', case when jsonb_array_length(v_failed) > 0 then v_failed end,
      'show', case when v_show is not null then jsonb_build_object('id', s.id, 'name', s.name, 'chosen_automatically', v_show_auto) end,
      'note', 'New cards are added as available, with the photo as the card''s photo. Cards with no price_cents are added with no price.')));
  end if;
  v_take := public._mcp_confirm_take('add_cards_from_photos', p_args, p_confirm_token, v_state);
  if v_take <> 'ok' then return jsonb_build_object('error', v_take); end if;

  -- inventory.source was made in the dashboard: only say 'agent' if the column takes it.
  v_src_ok := not exists (select 1 from pg_constraint where conrelid = 'public.inventory'::regclass and contype = 'c'
                            and pg_get_constraintdef(oid) ~ '\msource\M' and pg_get_constraintdef(oid) !~ 'agent');
  for d in select value from jsonb_array_elements(v_drafts) loop
    v_id := gen_random_uuid();
    perform public._mcp_insert_existing('inventory', jsonb_strip_nulls(jsonb_build_object(
      'id', v_id, 'seller_id', v_uid, 'card_title', coalesce(d->>'title', ''), 'player', d->>'player',
      'year', d->>'year', 'card_set', d->>'set', 'card_number', d->>'card_number', 'parallel', d->>'parallel',
      'grader', d->>'grader', 'grade', d->>'grade', 'cert_number', d->>'cert_number',
      'price', (d->>'price_cents')::numeric / 100, 'status', 'Available', 'item_type', 'card',
      'features', case when (d->>'autograph')::boolean then jsonb_build_array('Auto') end,
      'detected_confidence', d->'confidence',
      'primary_capture_id', d->>'capture_id', 'image_source', 'seller', 'source', case when v_src_ok then 'agent' end)));
    update public.card_captures set inventory_id = v_id, status = 'attached'
     where id = (d->>'capture_id')::uuid and seller_id = v_uid;
    if v_show is not null then
      insert into public.show_inventory (show_id, card_id) values (v_show, v_id) on conflict do nothing;
    end if;
    v_ids := v_ids || v_id;
    if d->>'grader' is not null and d->>'cert_number' is not null then v_gtcr := v_gtcr || v_id; end if;
  end loop;
  if to_regprocedure('public.assign_stock_codes(uuid[])') is not null then
    execute 'select public.assign_stock_codes($1)' using v_ids;
  end if;
  perform public._mcp_photo_job_applied(j.id);

  select coalesce(jsonb_agg(public._mcp_card_json(to_jsonb(i)) order by array_position(v_ids, i.id)), '[]'::jsonb) into v_created
    from public.inventory i where i.id = any(v_ids) and i.seller_id = v_uid;
  v_res := jsonb_strip_nulls(jsonb_build_object('added', cardinality(v_ids), 'cards', v_created,
    'published_to', case when v_show is not null then jsonb_build_object('id', s.id, 'name', s.name) end,
    'gtcr_recheck_ids', case when cardinality(v_gtcr) > 0 then to_jsonb(v_gtcr) end));
  perform public._mcp_store_result('add_cards_from_photos', p_client_request_id, p_args, v_res);
  return jsonb_build_object('stage', 'applied', 'result', v_res);
end $$;
-- ── grants ──────────────────────────────────────────────────────────────────
revoke all on function public.mcp_add_cards(jsonb, text, uuid) from public, anon;
grant execute on function public.mcp_add_cards(jsonb, text, uuid) to authenticated;

-- Check: should return 3
select count(*) from pg_proc where proname in ('mcp_add_cards', 'mcp_photo_upload_link', '_mcp_photo_link_create');
