-- Seller MCP server, Phase 3: bulk repricing, cards from photos, offers. Run after
-- 20261214120000_mcp_seller_phase2.sql (and the cost tracking and offers migrations). Re-runnable.
--
-- Same two-step pattern as Phase 2 (preview without p_confirm_token, apply with it), same token store.
--   mcp_set_prices            reprice up to 200 cards by a rule; all or nothing; client_request_id required
--   mcp_photo_job_start       registers a batch of up to 20 photos; the background function
--                             mcp-photo-job-background identifies them with scan-card (service role)
--   mcp_add_cards_from_photos while the job runs: {stage:'working'}; then a preview of the drafts; then creates them
--   mcp_my_offers             the dealer's offers (through dealer_offers())
--   mcp_respond_offer         accept / decline / counter through respond_offer(); emails are sent by the server
-- All seller functions run as the dealer (security invoker, RLS) except the job store helpers.

-- ── photo jobs ──────────────────────────────────────────────────────────────
create table if not exists public.mcp_photo_jobs (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null,
  client_id   text,
  status      text not null default 'working' check (status in ('working', 'done', 'applied')),
  images      jsonb not null default '[]'::jsonb,   -- [{n, source, url?, media_type?, capture_id, key, status, error?, card?, confidence?}]
  claimed_at  timestamptz,
  kicks       integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  finished_at timestamptz,
  applied_at  timestamptz
);
create index if not exists mcp_photo_jobs_owner_idx on public.mcp_photo_jobs (owner_id, created_at desc);
alter table public.mcp_photo_jobs enable row level security;
drop policy if exists mcp_photo_jobs_own_read on public.mcp_photo_jobs;
create policy mcp_photo_jobs_own_read on public.mcp_photo_jobs for select to authenticated using (owner_id = auth.uid());
revoke all on public.mcp_photo_jobs from anon, authenticated;
grant select on public.mcp_photo_jobs to authenticated;
grant all on public.mcp_photo_jobs to service_role;

-- p_args: {images: [{source:'url', url} | {source:'upload', media_type}]}. Returns the job with a capture id and
-- storage key per photo (the server uploads 'upload' photos to that key with the service key, into the dealer's
-- own folder of the private card-captures bucket).
create or replace function public.mcp_photo_job_start(p_args jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:write');
  v_imgs jsonb := coalesce(p_args->'images', '[]'::jsonb);
  v_out jsonb := '[]'::jsonb; v_img jsonb; v_n int := 0; v_cap uuid; v_id uuid; v_src text; v_url text;
  v_today int;
begin
  if jsonb_typeof(v_imgs) <> 'array' or jsonb_array_length(v_imgs) = 0 then
    return jsonb_build_object('error', 'bad_input', 'message', 'Send 1 to 20 photos.');
  end if;
  if jsonb_array_length(v_imgs) > 20 then
    return jsonb_build_object('error', 'bad_input', 'message', 'At most 20 photos per call. Send the rest in another call.');
  end if;
  if (select count(*) from public.mcp_photo_jobs where owner_id = v_uid and status = 'working'
        and created_at > now() - interval '30 minutes') >= 5 then
    return jsonb_build_object('error', 'busy', 'message', 'Five photo batches are still being read. Finish those first.');
  end if;
  select coalesce(sum(jsonb_array_length(images)), 0) into v_today from public.mcp_photo_jobs
   where owner_id = v_uid and created_at > now() - interval '1 day';
  if v_today + jsonb_array_length(v_imgs) > 300 then
    return jsonb_build_object('error', 'daily_limit', 'message', 'That is more than 300 photos today. Try again tomorrow.');
  end if;
  for v_img in select value from jsonb_array_elements(v_imgs) loop
    v_n := v_n + 1;
    v_src := v_img->>'source';
    v_url := nullif(trim(coalesce(v_img->>'url', '')), '');
    if v_src = 'url' and (v_url is null or v_url !~* '^https://' or length(v_url) > 2000) then
      return jsonb_build_object('error', 'bad_input', 'message', format('Photo %s: the URL must start with https://.', v_n));
    elsif v_src not in ('url', 'upload') then
      return jsonb_build_object('error', 'bad_input', 'message', format('Photo %s: send a url or base64 image.', v_n));
    end if;
    v_cap := gen_random_uuid();
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('n', v_n, 'source', v_src, 'url', case when v_src = 'url' then v_url end,
      'media_type', v_img->>'media_type', 'capture_id', v_cap, 'key', format('%s/%s/original.jpg', v_uid, v_cap), 'status', 'waiting')));
  end loop;
  insert into public.mcp_photo_jobs (owner_id, client_id, images) values (v_uid, public._mcp_client_id(), v_out) returning id into v_id;
  return jsonb_build_object('job_id', v_id, 'images', (select jsonb_agg(jsonb_build_object('n', e->'n', 'source', e->'source',
    'capture_id', e->'capture_id', 'key', e->'key')) from jsonb_array_elements(v_out) e));
end $$;
revoke all on function public.mcp_photo_job_start(jsonb) from public, anon;
grant execute on function public.mcp_photo_job_start(jsonb) to authenticated;

create or replace function public._mcp_photo_job_applied(p_job uuid) returns void
language sql security definer set search_path = public as $$
  update public.mcp_photo_jobs set status = 'applied', applied_at = now(), updated_at = now()
   where id = p_job and owner_id = auth.uid() and status = 'done'
$$;
revoke all on function public._mcp_photo_job_applied(uuid) from public, anon;
grant execute on function public._mcp_photo_job_applied(uuid) to authenticated;

-- One read photo as a draft card, with the dealer's overrides (o) applied.
create or replace function public._mcp_photo_draft(e jsonb, o jsonb) returns jsonb
language plpgsql immutable as $$
declare
  c jsonb := coalesce(e->'card', '{}'::jsonb); conf jsonb := coalesce(c->'confidence', '{}'::jsonb);
  v_player text; v_year text; v_set text; v_num text; v_par text; v_grader text; v_grade text; v_cert text; v_title text;
  v_low text[] := '{}'; k text; v_auto boolean := coalesce((c->>'autograph')::boolean, false);
begin
  o := coalesce(o, '{}'::jsonb);
  v_player := nullif(trim(coalesce(o->>'player', c->>'player_name', '')), '');
  v_year   := nullif(trim(coalesce(o->>'year', substring(c->>'year' from '\d{4}'), '')), '');
  v_set    := nullif(trim(coalesce(o->>'set', concat_ws(' ', c->>'set_name', c->>'subset'), '')), '');
  v_num    := nullif(trim(coalesce(o->>'card_number', c->>'card_number', '')), '');
  v_par    := nullif(trim(coalesce(o->>'parallel', concat_ws(' ', c->>'parallel_name', c->>'parallel_serial'), '')), '');
  v_grader := nullif(trim(coalesce(o->>'grader', c->>'grading_company', '')), '');
  v_grade  := nullif(trim(coalesce(o->>'grade', c->>'grade', '')), '');
  v_cert   := nullif(trim(coalesce(o->>'cert_number', c->>'cert_number', '')), '');
  if v_grader is null then v_grade := null; v_cert := null; end if;
  v_title  := coalesce(nullif(trim(coalesce(o->>'title', '')), ''),
                nullif(concat_ws(' ', v_year, v_set, v_player, v_par, case when v_auto and coalesce(v_par, '') !~* 'auto' then 'Auto' end), ''));
  -- Fields the scan wasn't sure about (below 0.7), unless the dealer typed them.
  foreach k in array array['player_name', 'year', 'set_name', 'grade', 'cert_number'] loop
    if (case k when 'player_name' then o ? 'player' when 'year' then o ? 'year' when 'set_name' then o ? 'set'
              when 'grade' then o ? 'grade' else o ? 'cert_number' end) then continue; end if;
    if k in ('grade', 'cert_number') and v_grader is null then continue; end if;
    if conf ? k and coalesce(public._mcp_num(conf->>k), 0) < 0.7 then
      v_low := v_low || case k when 'player_name' then 'player' when 'set_name' then 'set' else k end;
    end if;
  end loop;
  if v_player is null and not (o ? 'player') then v_low := v_low || 'player'; end if;
  return jsonb_strip_nulls(jsonb_build_object('index', (e->>'n')::int, 'title', v_title, 'player', v_player, 'year', v_year,
    'set', v_set, 'card_number', v_num, 'parallel', v_par, 'grader', v_grader, 'grade', v_grade, 'cert_number', v_cert,
    'autograph', v_auto, 'capture_id', e->>'capture_id',
    'confidence', conf, 'check_fields', to_jsonb(v_low), 'low_confidence', cardinality(v_low) > 0));
end $$;

-- p_args: {job_id, cards?: [{index, include?, price_cents?, title?, player?, year?, set?, card_number?, parallel?,
--          grader?, grade?, cert_number?}], show_id?: id | 'none'}
-- client_request_id is required.
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

-- ── set_prices ──────────────────────────────────────────────────────────────
-- p_args: {inventory_ids: [≤200], rule: {type: 'pct_of_comp', percent} | {type: 'change_percent', percent}
--          | {type: 'change_cents', cents} | {type: 'set_cents', cents}, round_to?: 'cent'|'dollar'|'five_dollars',
--          floor_cents?, ceiling_cents?}. client_request_id is required. All or nothing.
create or replace function public.mcp_set_prices(p_args jsonb, p_confirm_token text default null, p_client_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:write');
  v_rule jsonb := p_args->'rule'; v_type text := p_args->'rule'->>'type';
  v_pct numeric := public._mcp_num(p_args->'rule'->>'percent');
  v_amt numeric := public._mcp_num(p_args->'rule'->>'cents');
  v_round text := coalesce(nullif(p_args->>'round_to', ''), 'dollar');
  v_floor bigint; v_ceil bigint; v_ids uuid[] := '{}'; v_x text; v_id uuid;
  r jsonb; v_old bigint; v_comp bigint; v_new numeric; v_newc bigint; v_unit int;
  v_changes jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb; v_state text := ''; v_take text; v_res jsonb; v_replay jsonb;
  v_before bigint := 0; v_after bigint := 0; v_n int;
begin
  if p_client_request_id is null then
    return jsonb_build_object('error', 'bad_input', 'message', 'client_request_id is required: a new UUID for this repricing, reused if you retry it.');
  end if;
  v_replay := public._mcp_replay(p_client_request_id);
  if v_replay is not null then return jsonb_build_object('stage', 'applied', 'replayed', true, 'result', v_replay); end if;
  if public._mcp_token_used(p_confirm_token) then return jsonb_build_object('error', 'token_used'); end if;

  if jsonb_typeof(p_args->'inventory_ids') <> 'array' or jsonb_array_length(p_args->'inventory_ids') = 0 then
    return jsonb_build_object('error', 'bad_input', 'message', 'inventory_ids is required (card ids from list_my_inventory).');
  end if;
  if jsonb_array_length(p_args->'inventory_ids') > 200 then
    return jsonb_build_object('error', 'too_many', 'message', 'At most 200 cards per call. Split the rest into another call.');
  end if;
  for v_x in select value from jsonb_array_elements_text(p_args->'inventory_ids') loop
    v_id := public._mcp_uuid(v_x);
    if v_id is null then return jsonb_build_object('error', 'bad_input', 'message', format('"%s" is not a card id.', left(v_x, 60))); end if;
    if not v_id = any(v_ids) then v_ids := v_ids || v_id; end if;
  end loop;
  if v_type is null or v_type not in ('pct_of_comp', 'change_percent', 'change_cents', 'set_cents') then
    return jsonb_build_object('error', 'bad_input', 'message', 'rule.type must be pct_of_comp, change_percent, change_cents or set_cents.');
  end if;
  if v_type in ('pct_of_comp', 'change_percent') and v_pct is null then
    return jsonb_build_object('error', 'bad_input', 'message', 'rule.percent is required, e.g. 90 for 90% of comp or -10 to lower by 10%.');
  end if;
  if v_type = 'pct_of_comp' and (v_pct <= 0 or v_pct > 500) then
    return jsonb_build_object('error', 'bad_input', 'message', 'rule.percent for pct_of_comp must be between 1 and 500.');
  end if;
  if v_type = 'change_percent' and (v_pct <= -100 or v_pct > 500) then
    return jsonb_build_object('error', 'bad_input', 'message', 'rule.percent for change_percent must be above -100 and at most 500.');
  end if;
  if v_type in ('change_cents', 'set_cents') and (v_amt is null or v_amt <> trunc(v_amt)) then
    return jsonb_build_object('error', 'bad_input', 'message', 'rule.cents must be a whole number of cents.');
  end if;
  if v_type = 'set_cents' and v_amt < 1 then
    return jsonb_build_object('error', 'bad_input', 'message', 'rule.cents for set_cents must be at least 1.');
  end if;
  if v_round not in ('cent', 'dollar', 'five_dollars') then
    return jsonb_build_object('error', 'bad_input', 'message', 'round_to must be cent, dollar or five_dollars.');
  end if;
  v_unit := case v_round when 'cent' then 1 when 'dollar' then 100 else 500 end;
  begin
    v_floor := nullif(p_args->>'floor_cents', '')::bigint;
    v_ceil := nullif(p_args->>'ceiling_cents', '')::bigint;
  exception when others then
    return jsonb_build_object('error', 'bad_input', 'message', 'floor_cents and ceiling_cents must be whole numbers of cents.');
  end;
  if v_floor is not null and v_floor < 1 then return jsonb_build_object('error', 'bad_input', 'message', 'floor_cents must be at least 1.'); end if;
  if v_floor is not null and v_ceil is not null and v_ceil < v_floor then
    return jsonb_build_object('error', 'bad_input', 'message', 'ceiling_cents must be at least floor_cents.');
  end if;

  foreach v_id in array v_ids loop
    r := public._mcp_own_card(v_uid, v_id);
    if r is null then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('inventory_id', v_id, 'reason', 'not_found')); continue;
    end if;
    if public._mcp_card_status(r) <> 'available' then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('inventory_id', v_id, 'title', r->>'card_title',
        'reason', public._mcp_card_status(r))); continue;
    end if;
    v_old := public._mcp_cents(r->>'price');
    if v_old = 0 then v_old := null; end if;
    v_comp := case when public._mcp_comp_visible(r) then (r->>'comp_value_cents')::bigint end;
    v_new := case v_type
      when 'pct_of_comp' then v_comp * v_pct / 100
      when 'change_percent' then v_old * (1 + v_pct / 100)
      when 'change_cents' then v_old + v_amt
      else v_amt end;
    if v_new is null then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('inventory_id', v_id, 'title', r->>'card_title',
        'reason', case when v_type = 'pct_of_comp' then 'no_comp' else 'no_price' end)); continue;
    end if;
    v_newc := (round(v_new / v_unit) * v_unit)::bigint;
    if v_floor is not null and v_newc < v_floor then v_newc := v_floor; end if;
    if v_ceil is not null and v_newc > v_ceil then v_newc := v_ceil; end if;
    if v_newc < 1 then v_newc := v_unit; end if;
    if v_newc = v_old then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('inventory_id', v_id, 'title', r->>'card_title', 'reason', 'unchanged'));
      continue;
    end if;
    v_before := v_before + coalesce(v_old, 0); v_after := v_after + v_newc;
    v_state := v_state || public._mcp_card_state(v_id);
    v_changes := v_changes || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('inventory_id', v_id, 'title', r->>'card_title',
      'stock_code', r->>'stock_code', 'old_price_cents', v_old, 'old_price', coalesce(public._mcp_dollars(v_old), 'no price'),
      'new_price_cents', v_newc, 'new_price', public._mcp_dollars(v_newc), 'comp_cents', v_comp,
      'new_pct_of_comp', case when v_comp > 0 then round(v_newc::numeric / v_comp, 3) end,
      'at_floor', case when v_floor is not null and v_newc = v_floor then true end,
      'at_ceiling', case when v_ceil is not null and v_newc = v_ceil then true end)));
  end loop;
  if jsonb_array_length(v_changes) = 0 then
    return jsonb_build_object('error', 'no_changes', 'message', 'None of these cards would change price.', 'skipped', v_skipped);
  end if;
  v_state := md5(v_state);

  if p_confirm_token is null then
    return public._mcp_confirm_issue('set_prices', p_args, v_state, jsonb_strip_nulls(jsonb_build_object(
      'action', 'Change prices', 'rule', v_rule, 'round_to', v_round, 'floor_cents', v_floor, 'ceiling_cents', v_ceil,
      'changes', v_changes, 'count', jsonb_array_length(v_changes),
      'total_before_cents', v_before, 'total_before', public._mcp_dollars(v_before),
      'total_after_cents', v_after, 'total_after', public._mcp_dollars(v_after),
      'skipped', case when jsonb_array_length(v_skipped) > 0 then v_skipped end,
      'note', 'All of these prices change together, or none do.')));
  end if;
  v_take := public._mcp_confirm_take('set_prices', p_args, p_confirm_token, v_state);
  if v_take <> 'ok' then return jsonb_build_object('error', v_take); end if;

  update public.inventory i set price = (c->>'new_price_cents')::numeric / 100, updated_at = now()
    from jsonb_array_elements(v_changes) c
   where i.id = (c->>'inventory_id')::uuid and i.seller_id = v_uid;
  get diagnostics v_n = row_count;
  if v_n <> jsonb_array_length(v_changes) then
    raise exception 'mcp:bad_input:Some cards could not be changed, so none were. Preview it again.';
  end if;
  v_res := jsonb_build_object('updated', v_n, 'total_before', public._mcp_dollars(v_before), 'total_after', public._mcp_dollars(v_after),
    'changes', (select jsonb_agg(jsonb_build_object('inventory_id', c->'inventory_id', 'title', c->'title', 'old_price', c->'old_price',
      'new_price', c->'new_price')) from jsonb_array_elements(v_changes) c));
  perform public._mcp_store_result('set_prices', p_client_request_id, p_args, v_res);
  return jsonb_build_object('stage', 'applied', 'result', v_res);
end $$;

-- ── offers ──────────────────────────────────────────────────────────────────
create or replace function public._mcp_offer_out(x jsonb) returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'offer_id', x->>'id', 'status', x->>'status',
    'your_turn', x->>'status' = 'pending',
    'offer_cents', (x->>'amount_cents')::bigint, 'offer', public._mcp_dollars((x->>'amount_cents')::bigint),
    'first_offer_cents', (x->>'offer_cents')::bigint,
    'asking_cents', (x->>'asking_cents')::bigint, 'asking', public._mcp_dollars((x->>'asking_cents')::bigint),
    'pct_of_asking', case when (x->>'asking_cents')::numeric > 0 then round((x->>'amount_cents')::numeric / (x->>'asking_cents')::numeric, 3) end,
    'last_move_by', x->>'last_by', 'moves', (x->>'moves')::int, 'can_counter', (x->>'can_counter')::boolean,
    'history', x->'history', 'expires_at', x->>'expires_at', 'end_reason', x->>'end_reason',
    'buyer_name', x->>'buyer_name', 'buyer_note', x->>'buyer_note',
    'answered_automatically', x->'auto_log',
    'card_count', (x->>'card_count')::int,
    'cards', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('inventory_id', c->>'id', 'title', c->>'title', 'stock_code', c->>'stock_code',
               'price_cents', (c->>'price_cents')::bigint, 'price', public._mcp_dollars((c->>'price_cents')::bigint),
               'comp_cents', (c->>'comp_value_cents')::bigint))) from jsonb_array_elements(coalesce(x->'cards', '[]'::jsonb)) c),
    'hold', x->'hold'))
$$;

-- p: {status: 'to_answer' (default: offers waiting for the dealer) | 'open' | 'all', limit}
create or replace function public.mcp_my_offers(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('inventory:read');
  v_status text := coalesce(nullif(p->>'status', ''), 'to_answer');
  v_limit int := least(greatest(coalesce(public._mcp_num(p->>'limit')::int, 50), 1), 100);
  v_all jsonb; v_out jsonb;
begin
  if v_status not in ('to_answer', 'open', 'all') then raise exception 'mcp:bad_input:status must be to_answer, open or all'; end if;
  if to_regprocedure('public.dealer_offers()') is null then
    return jsonb_build_object('results', '[]'::jsonb, 'total', 0, 'note', 'Offers aren''t set up on CardShow yet.');
  end if;
  execute 'select public.dealer_offers()' into v_all;
  select coalesce(jsonb_agg(public._mcp_offer_out(x)), '[]'::jsonb) into v_out from (
    select x from jsonb_array_elements(coalesce(v_all, '[]'::jsonb)) x
     where v_status = 'all' or (v_status = 'open' and x->>'status' in ('pending', 'countered'))
        or (v_status = 'to_answer' and x->>'status' = 'pending')
     limit v_limit) q;
  return jsonb_build_object('results', v_out, 'total', jsonb_array_length(v_out),
    'note', 'pending = waiting for the dealer; countered = waiting for the buyer. Ended offers are kept for 3 days.');
end $$;

-- p_args: {offer_id, action: accept|decline|counter, counter_cents?}
create or replace function public.mcp_respond_offer(p_args jsonb, p_confirm_token text default null, p_client_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := public._mcp_require('offers:write');
  v_offer uuid := public._mcp_uuid(p_args->>'offer_id');
  v_action text := lower(trim(coalesce(p_args->>'action', '')));
  v_counter bigint := public._mcp_num(p_args->>'counter_cents')::bigint;
  v_all jsonb; x jsonb; v_state text; v_take text; v_r jsonb; v_res jsonb; v_replay jsonb; v_price bigint;
begin
  if p_client_request_id is not null then
    v_replay := public._mcp_replay(p_client_request_id);
    if v_replay is not null then return jsonb_build_object('stage', 'applied', 'replayed', true, 'result', v_replay); end if;
  end if;
  if public._mcp_token_used(p_confirm_token) then return jsonb_build_object('error', 'token_used'); end if;
  if v_offer is null then return jsonb_build_object('error', 'bad_input', 'message', 'offer_id must be an id from list_offers.'); end if;
  if v_action not in ('accept', 'decline', 'counter') then
    return jsonb_build_object('error', 'bad_input', 'message', 'action must be accept, decline or counter.');
  end if;
  if to_regprocedure('public.dealer_offers()') is null then
    return jsonb_build_object('error', 'not_found', 'message', 'Offers aren''t set up on CardShow yet.');
  end if;
  execute 'select public.dealer_offers()' into v_all;
  select e into x from jsonb_array_elements(coalesce(v_all, '[]'::jsonb)) e where e->>'id' = v_offer::text;
  if x is null then return jsonb_build_object('error', 'not_found', 'message', 'No offer with that id for your cards.'); end if;
  if x->>'status' = 'countered' then
    return jsonb_build_object('error', 'not_your_turn', 'message', 'You already answered; the buyer hasn''t replied yet.');
  elsif x->>'status' <> 'pending' then
    return jsonb_build_object('error', 'offer_ended', 'message', format('This offer is %s.', x->>'status'));
  end if;
  select sum(coalesce((c->>'price_cents')::bigint, 0)) into v_price from jsonb_array_elements(x->'cards') c;
  if v_action = 'counter' then
    if not coalesce((x->>'can_counter')::boolean, false) then
      return jsonb_build_object('error', 'no_more_counters', 'message', 'No more counters on this offer: accept or decline it.');
    end if;
    if v_counter is null or public._mcp_num(p_args->>'counter_cents') <> v_counter
       or v_counter <= (x->>'amount_cents')::bigint or v_counter >= v_price then
      return jsonb_build_object('error', 'bad_counter', 'message', format('counter_cents must be more than the offer (%s) and less than the asking price (%s).',
        public._mcp_dollars((x->>'amount_cents')::bigint), public._mcp_dollars(v_price)),
        'min_cents', (x->>'amount_cents')::bigint + 1, 'max_cents', v_price - 1);
    end if;
  elsif p_args ? 'counter_cents' then
    return jsonb_build_object('error', 'bad_input', 'message', 'counter_cents is only for action counter.');
  end if;

  v_state := md5(concat_ws('|', x->>'status', x->>'amount_cents', x->>'moves', x->>'updated_at', x->>'expires_at',
    (select string_agg(concat_ws(':', c->>'id', c->>'price_cents', c->>'listing_status', c->>'status'), ',') from jsonb_array_elements(x->'cards') c)));
  if p_confirm_token is null then
    return public._mcp_confirm_issue('respond_to_offer', p_args, v_state, jsonb_strip_nulls(jsonb_build_object(
      'action', case v_action when 'accept' then 'Accept offer' when 'decline' then 'Decline offer' else 'Counter offer' end,
      'offer', public._mcp_offer_out(x),
      'counter_cents', case when v_action = 'counter' then v_counter end,
      'counter', case when v_action = 'counter' then public._mcp_dollars(v_counter) end,
      'what_happens', case v_action
        when 'accept' then format('The card(s) go on hold for %s at %s (24 hours). They pay you when you meet or through your payment links. They get an email.',
                                  coalesce(x->>'buyer_name', 'the buyer'), public._mcp_dollars((x->>'amount_cents')::bigint))
        when 'decline' then format('The offer ends and %s gets an email. The card(s) stay listed.', coalesce(x->>'buyer_name', 'the buyer'))
        else format('%s gets an email with your counter of %s and can accept, counter or decline.', coalesce(x->>'buyer_name', 'The buyer'),
                    public._mcp_dollars(v_counter)) end)));
  end if;
  v_take := public._mcp_confirm_take('respond_to_offer', p_args, p_confirm_token, v_state);
  if v_take <> 'ok' then return jsonb_build_object('error', v_take); end if;

  execute 'select public.respond_offer($1, $2, $3)' into v_r using v_offer, v_action, v_counter::integer;
  if v_r ? 'error' then
    return jsonb_build_object('error', 'offer_refused', 'message', case v_r->>'error'
      when 'expired' then 'The offer ran out of time.'
      when 'not_your_turn' then 'The offer changed: it is no longer waiting for you.'
      when 'unavailable' then 'A card in this offer is no longer for sale, so the offer was closed.'
      when 'no_more_counters' then 'No more counters on this offer.'
      when 'bad_counter' then 'That counter is out of range.'
      else 'CardShow couldn''t answer this offer.' end);
  end if;
  v_res := jsonb_strip_nulls(jsonb_build_object('offer_id', v_offer, 'action', v_action, 'offer_status', v_r->>'status',
    'amount', public._mcp_dollars(coalesce((v_r->>'amount_cents')::bigint, (x->>'amount_cents')::bigint)),
    'hold_until', v_r->>'expires_at', 'buyer_notified', true));
  if p_client_request_id is not null then perform public._mcp_store_result('respond_to_offer', p_client_request_id, p_args, v_res); end if;
  return jsonb_build_object('stage', 'applied', 'result', v_res);
end $$;

-- ── grants ──────────────────────────────────────────────────────────────────
revoke all on function public.mcp_add_cards_from_photos(jsonb, text, uuid), public.mcp_set_prices(jsonb, text, uuid),
  public.mcp_my_offers(jsonb), public.mcp_respond_offer(jsonb, text, uuid) from public, anon;
grant execute on function public.mcp_add_cards_from_photos(jsonb, text, uuid), public.mcp_set_prices(jsonb, text, uuid),
  public.mcp_my_offers(jsonb), public.mcp_respond_offer(jsonb, text, uuid) to authenticated;

-- Check: should return 5
select count(*) from pg_proc where proname in ('mcp_photo_job_start', 'mcp_add_cards_from_photos', 'mcp_set_prices', 'mcp_my_offers', 'mcp_respond_offer');
