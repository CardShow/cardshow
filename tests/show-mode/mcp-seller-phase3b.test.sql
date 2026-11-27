-- Seller MCP Phase 3b. Run with mcp-seller-phase3b.test.sh (after the Phase 3 test data). PASS / FAIL per check.
\set ON_ERROR_STOP 1
reset role; reset session authorization;
create or replace function pg_temp.ok(p_name text, p_cond boolean) returns text language sql as $$
  select case when coalesce(p_cond, false) then 'PASS ' else 'FAIL ' end || p_name $$;
create or replace function pg_temp.as_user(p_uid text, p_client text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  perform set_config('request.jwt.claims', case when p_uid is null then '' else
    (jsonb_build_object('sub', p_uid, 'role', 'authenticated') || case when p_client is null then '{}'::jsonb
      else jsonb_build_object('client_id', p_client) end)::text end, false);
end $$;
\set A '''aaaaaaaa-0000-0000-0000-000000000001'''
\set B '''bbbbbbbb-0000-0000-0000-000000000002'''
\set R1 '''33333333-0000-0000-0000-000000000001'''

set session authorization authenticator; set role authenticated;
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('01 client_request_id required',
  (mcp_add_cards('{"cards":[{"player":"Anthony Volpe"}]}'::jsonb))->>'error' = 'bad_input');
select pg_temp.ok('02 bad input explained per card',
  (mcp_add_cards('{"cards":[{"player":"A"},{"player":"B","year":"20"}]}'::jsonb, null, :R1))->>'message' = 'Card 2: year must be 4 digits.'
  and (mcp_add_cards('{"cards":[{"player":"A","features":["Shiny"]}]}'::jsonb, null, :R1))->>'message' like 'Card 1: features can be%'
  and (mcp_add_cards('{"cards":[{"set":"Prizm"}]}'::jsonb, null, :R1))->>'message' like 'Card 1: give at least the player%'
  and (mcp_add_cards(jsonb_build_object('cards', (select jsonb_agg('{"player":"x"}'::jsonb) from generate_series(1, 21))), null, :R1))->>'error' = 'bad_input');

\set ARGS '''{"cards":[{"player":"Anthony Volpe","year":"2020","set":"Bowman Chrome Prospects","parallel":"Mojo Refractor","features":["refractor"],"unsure_fields":["year","card_number"],"price_cents":4500},{"player":"Dup Slab","grader":"PSA","grade":"9","cert_number":"55555"},{"player":"Sal Frelick","year":"2021","set":"Bowman Draft","grader":"Raw","grade":"10"}]}'''
select mcp_add_cards(:ARGS::jsonb, null, :R1) as p \gset
select pg_temp.ok('03 preview: what the assistant read, unsure fields flagged, title built, the slab already in inventory skipped, nothing added',
  (:'p'::jsonb)->>'stage' = 'preview' and ((:'p'::jsonb)->'preview'->>'count')::int = 2 and ((:'p'::jsonb)->'preview'->>'need_a_check')::int = 1
  and (:'p'::jsonb)->'preview'->'cards' @> '[{"index":1,"title":"2020 Bowman Chrome Prospects Anthony Volpe Mojo Refractor","features":["Refractor"],"check_fields":["year","card_number"],"price":"$45.00"}]'
  and (:'p'::jsonb)->'preview'->'cards' @> '[{"index":3,"player":"Sal Frelick","low_confidence":false}]'
  and not ((:'p'::jsonb)->'preview'->'cards'->1 ? 'grader')
  and (:'p'::jsonb)->'preview'->'skipped' @> '[{"index":2,"duplicate_of":"a0000000-0000-0000-0000-000000000099"}]'
  and (:'p'::jsonb)->'preview'->'show'->>'id' = 's_today'
  and not exists (select 1 from inventory where player = 'Anthony Volpe'));
select pg_temp.ok('04 different arguments with that token refused',
  (mcp_add_cards('{"cards":[{"player":"Someone"}]}'::jsonb, (:'p'::jsonb)->>'confirm_token', :R1))->>'error' = 'arguments_changed');
select (mcp_add_cards(:ARGS::jsonb, null, :R1))->>'confirm_token' as tok \gset
select mcp_add_cards(:ARGS::jsonb, :'tok', :R1) as a \gset
select pg_temp.ok('05 confirmed: cards added as available, stock codes, published to today''s show, a photo link returned',
  (:'a'::jsonb)->>'stage' = 'applied' and ((:'a'::jsonb)->'result'->>'added')::int = 2
  and (select count(*) from inventory where seller_id = :A and player in ('Anthony Volpe', 'Sal Frelick') and status = 'Available' and stock_code is not null) = 2
  and (select features from inventory where player = 'Anthony Volpe') = array['Refractor'] and (select price from inventory where player = 'Anthony Volpe') = 45
  and (select count(*) from show_inventory si join inventory i on i.id = si.card_id where si.show_id = 's_today' and i.player in ('Anthony Volpe', 'Sal Frelick')) = 2
  and (:'a'::jsonb)->'result'->>'photo_link_code' ~ '^[A-Z2-9]{10}$');
select (:'a'::jsonb)->'result'->>'photo_link_code' as code \gset
reset role; reset session authorization;
select pg_temp.ok('06 the link is stored hashed, for those two cards only, for 30 minutes',
  (select count(*) from mcp_photo_links where code_hash = _mcp_token_hash(:'code') and kind = 'attach' and owner_id = :A
     and cardinality(inventory_ids) = 2 and expires_at between now() + interval '29 minutes' and now() + interval '31 minutes') = 1
  and not exists (select 1 from mcp_photo_links where code_hash = :'code'));
set session authorization authenticator; set role authenticated;
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('07 the same request again adds nothing and returns the same link',
  (mcp_add_cards(:ARGS::jsonb, :'tok', :R1))->>'replayed' = 'true'
  and (mcp_add_cards(:ARGS::jsonb, null, :R1))->'result'->>'photo_link_code' = :'code'
  and (select count(*) from inventory where player = 'Anthony Volpe') = 1);
select pg_temp.ok('08 dealers can''t read photo links', (select count(*) from (select 1 from pg_class where false) x) = 0
  and not has_table_privilege('authenticated', 'public.mcp_photo_links', 'select'));
select mcp_photo_upload_link('{}'::jsonb) as ul \gset
select pg_temp.ok('09 photo_upload_link: a batch waiting for photos and its code',
  (:'ul'::jsonb)->>'code' ~ '^[A-Z2-9]{10}$'
  and (mcp_add_cards_from_photos(jsonb_build_object('job_id', (:'ul'::jsonb)->>'job_id'), null, '33333333-0000-0000-0000-000000000002'))->>'waiting_for_upload' = 'true');
select pg_temp.as_user(:B, 'claude-client');
select pg_temp.ok('10 another dealer can''t use that batch',
  (mcp_add_cards_from_photos(jsonb_build_object('job_id', (:'ul'::jsonb)->>'job_id'), null, '33333333-0000-0000-0000-000000000003'))->>'error' = 'not_found');
select pg_temp.as_user(:A, 'read-only');
do $$ begin perform mcp_add_cards('{"cards":[{"player":"x"}]}'::jsonb, null, '33333333-0000-0000-0000-000000000009');
  raise notice 'FAIL 11 read-only assistant added cards';
exception when others then raise notice 'PASS 11 read-only assistant can''t add cards: %', sqlerrm; end $$;
do $$ begin perform mcp_photo_upload_link('{}'::jsonb); raise notice 'FAIL 12 read-only assistant made a photo link';
exception when others then raise notice 'PASS 12 read-only assistant can''t make a photo link: %', sqlerrm; end $$;
