-- Make an Offer (20261208120000_marketplace_offers.sql). Run with marketplace-offers.test.sh.
-- Setup copied from buyer-site.test.sql. Prints PASS or FAIL per check.
\set ON_ERROR_STOP 1
alter table inventory add column if not exists sold_date text, add column if not exists sale_notes text;
alter table sellers add column if not exists display_name text, add column if not exists instagram text,
  add column if not exists email text, add column if not exists whatsapp text;
alter table shows add column if not exists listed boolean default false, add column if not exists merged_into text;
alter table auth.users add column if not exists email text;
alter table show_floor_transactions
  add column if not exists api_eligible boolean default true, add column if not exists card_title text,
  add column if not exists item_type text, add column if not exists client_sale_id uuid;
create table if not exists public.admins (id uuid primary key);
create table if not exists public.platform_admins (id uuid primary key);
\i ../../supabase/migrations/20261023120000_show_mode_sales.sql
\i ../../supabase/migrations/20261101120000_gtcr_buyer_badge.sql
\i ../../supabase/migrations/20261102120000_gtcr_daily_recheck.sql
\i ../../supabase/migrations/20261122120000_marketplace_listings.sql
\i ../../supabase/migrations/20261123120000_marketplace_sold_on_insert.sql
alter table inventory enable row level security;
create policy "Allow all" on inventory for all using (true) with check (true);
\i ../../supabase/migrations/20261124120000_inventory_rls.sql
\i ../../supabase/migrations/20261129120000_marketplace_listing_photos.sql
-- As in production: is_cardshow_admin() = anyone in admins (every organizer), defined before pricing_search.
create or replace function public.is_cardshow_admin() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from admins where id = auth.uid()) $$;
grant execute on function public.is_cardshow_admin() to authenticated, service_role;
\i ../../supabase/migrations/20261130120000_marketplace_pricing_search.sql
\i ../../supabase/migrations/20261202120000_pricing_admin.sql
alter table shows add column if not exists slug text, add column if not exists website text;
\i ../../supabase/migrations/20261203120000_marketplace_buyer_site.sql
\i ../../supabase/migrations/20261204120000_marketplace_photo_ranking.sql
\i ../../supabase/migrations/20261205120000_pricing_review.sql
\i ../../supabase/migrations/20261206120000_marketplace_show_pages.sql
\i ../../supabase/migrations/20261206120000_marketplace_show_pages.sql
\i ../../supabase/migrations/20261207120000_marketplace_holds.sql
\i ../../supabase/migrations/20261208120000_marketplace_offers.sql
\i ../../supabase/migrations/20261208120000_marketplace_offers.sql
\i ../../supabase/migrations/20261209120000_marketplace_bundle_offers.sql
\i ../../supabase/migrations/20261209120000_marketplace_bundle_offers.sql
grant all on all tables in schema public to service_role;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on inventory to authenticated;
revoke all on public.pricing_cards, public.card_values, public.pricing_api_usage, public.agent_actions,
              public.api_rate_limits, public.pricing_identity_claims, public.marketplace_settings from anon, authenticated;
grant select on public.agent_actions to authenticated;
grant select, insert, update, delete on public.saved_searches to authenticated;
revoke all on public.saved_searches from anon;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;
alter role service_role bypassrls;
-- Show Directory, self-join, shows/show_inventory security and geocoding, as in production.
alter table shows add column if not exists created_by uuid;
\i ../../supabase/migrations/20261027120000_seller_self_join.sql
\i ../../supabase/migrations/20261028120000_show_directory.sql
alter table shows enable row level security;
create policy "Allow all" on shows for all using (true) with check (true);
\i ../../supabase/migrations/20261128120000_shows_rls.sql
alter table show_inventory enable row level security;
create policy "Allow all si" on show_inventory for all using (true) with check (true);
\i ../../supabase/migrations/20261125120000_show_inventory_rls.sql
\i ../../supabase/migrations/20261201120000_show_geocoding.sql
\i ../../supabase/migrations/20261210120000_csf_events.sql
\i ../../supabase/migrations/20261210120000_csf_events.sql
grant all on all tables in schema public to service_role;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on inventory to authenticated;
grant insert, update, delete on shows to authenticated;
revoke all on public.external_sync_runs, public.external_event_matches, public.external_show_removals, public.external_show_notices from anon;
revoke all on public.external_show_notices from authenticated;

create function pg_temp.ok(label text, cond boolean) returns void language plpgsql as $$
begin if coalesce(cond, false) then raise notice 'PASS  %', label; else raise notice 'FAIL  %', label; end if; end $$;
-- One CSF event as the feed sends it; dates as offsets from today.
create function pg_temp.ev(p_id int, p_name text, p_type text, p_from int, p_to int, p_city text, p_state text,
                           p_lat float8 default null, p_lng float8 default null) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'name', p_name, 'type', p_type,
    'date_start', to_char(current_date + p_from, 'YYYY-MM-DD'), 'date_end', to_char(current_date + p_to, 'YYYY-MM-DD'),
    'time_start', case when p_id % 2 = 0 then null else '09:00' end, 'time_end', case when p_id % 2 = 0 then null else '17:00' end,
    'venue', 'Hall ' || p_id, 'address', '100 Main St', 'city', p_city, 'state', p_state, 'postal_code', '75201',
    'lat', p_lat, 'lng', p_lng, 'admission_price', case when p_id % 2 = 0 then null else 10 end, 'featured', false,
    'updated_at', '2026-10-20T15:04:05Z',
    'url', 'https://thecardshopfinder.com/event/e' || p_id || '/?utm_source=cardshow&utm_medium=partner_feed&utm_campaign=events')
$$;
\set TYPES '''{card_show,sports,convention}''::text[]'

-- people: dealer A (in the CSF show), buyers C and D, organizer O, platform owner P
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.test'),
  ('cccccccc-0000-0000-0000-000000000003', 'c@example.test'), ('dddddddd-0000-0000-0000-000000000004', 'd@example.test'),
  ('eeeeeeee-0000-0000-0000-00000000000e', 'o@example.test'), ('ffffffff-0000-0000-0000-00000000000f', 'p@example.test');
insert into sellers (id, handle, display_name) values ('aaaaaaaa-0000-0000-0000-000000000001', 'dealer_a', 'Dealer A');
insert into admins values ('eeeeeeee-0000-0000-0000-00000000000e');
insert into platform_admins values ('ffffffff-0000-0000-0000-00000000000f');
-- Organizer shows: the same Monster Show (one day inside CSF's three), a near miss, and an unrelated Sacramento show.
insert into shows (id, name, start_date, end_date, venue, city, state, listed, created_by) values
  ('org_monster', 'Monster Collectibles Show', current_date + 11, current_date + 11, 'Cal Expo', 'Sacramento', 'CA', true, 'eeeeeeee-0000-0000-0000-00000000000e'),
  ('org_wche', 'WCHE Lakewood Card Expo', current_date + 20, current_date + 21, 'Mall', 'Lakewood', 'CA', true, 'eeeeeeee-0000-0000-0000-00000000000e'),
  ('org_sac', 'Sacramento Sports Card Show', current_date + 30, current_date + 30, 'Hall', 'Sacramento', 'CA', true, 'eeeeeeee-0000-0000-0000-00000000000e');

create temp table feed as select jsonb_build_array(
  pg_temp.ev(1, 'Dallas Card Show', 'card_show', 3, 4, 'Dallas', 'TX', 32.7767, -96.797),
  pg_temp.ev(2, 'Pokemon League Cup', 'pokemon', 5, 5, 'Austin', 'TX'),
  pg_temp.ev(4, 'Phoenix Convention', 'convention', -1, -1, 'Phoenix', 'AZ'),
  pg_temp.ev(5, 'The Monster Collectibles Show 2026', 'card_show', 10, 12, 'sacramento', 'CA'),
  pg_temp.ev(7, 'West Coast Hobby Expo Lakewood', 'card_show', 20, 21, 'Lakewood', 'CA'),
  pg_temp.ev(9, 'Capital City Comic Con', 'convention', 30, 30, 'Sacramento', 'CA'),
  pg_temp.ev(11, 'Houston Sports Card Show', 'sports', 40, 40, 'Houston', 'TX')) as e;

-- ── First sync ──
select csf_sync_apply((select e from feed), :TYPES) as r1 \gset
select pg_temp.ok('first sync: 7 events, 4 new shows, 1 linked, 1 to review', (:'r1'::jsonb->>'received')::int = 7 and (:'r1'::jsonb->>'shows_created')::int = 4
       and (:'r1'::jsonb->>'shows_linked')::int = 1 and (:'r1'::jsonb->>'matches_pending')::int = 1);
select pg_temp.ok('no show for a pokemon event', not exists (select 1 from shows where id = 'show_csf2'));
select pg_temp.ok('Dallas show: listed, csf, slug, dates text, tz, coords from CSF',
  (select listed and source = 'csf' and slug like 'dallas-card-show-%' and date = _show_date_text(current_date + 3, current_date + 4)
          and timezone = 'America/Chicago' and latitude = 32.7767 and geo_source = 'csf' and seller_self_join
          and location = 'Hall 1, Dallas, TX' and access_code ~ '^[A-Z0-9]{6}$' from shows where id = 'show_csf1'));
select pg_temp.ok('no coordinates left for the geocoder', (select latitude is null and geo_source is null from shows where id = 'show_csf4'));
select pg_temp.ok('date text matches the app', _show_date_text('2026-08-29', '2026-08-30') = 'Aug 29-30, 2026'
  and _show_date_text('2026-08-29', '2026-08-29') = 'Aug 29, 2026' and _show_date_text('2026-08-30', '2026-09-01') = 'Aug 30 - Sep 1, 2026');
select pg_temp.ok('organizer''s Monster show linked (multi-day vs one day), its details kept',
  (select external_event_id = (select id from external_events where source_event_id = 5) and name = 'Monster Collectibles Show'
          and source = 'cardshow' from shows where id = 'org_monster'));
select pg_temp.ok('near-miss WCHE name goes to review, no show yet',
  exists (select 1 from external_event_matches m join external_events e on e.id = m.external_event_id
           where e.source_event_id = 7 and m.show_id = 'org_wche' and m.status = 'pending')
  and not exists (select 1 from shows where id = 'show_csf7'));
select pg_temp.ok('different show same city same day: new show, organizer''s untouched',
  exists (select 1 from shows where id = 'show_csf9') and (select external_event_id is null from shows where id = 'org_sac'));
select pg_temp.ok('url stored exactly', (select source_url from external_events where source_event_id = 1)
  = 'https://thecardshopfinder.com/event/e1/?utm_source=cardshow&utm_medium=partner_feed&utm_campaign=events');

-- ── Same feed again: nothing new ──
select csf_sync_apply((select e from feed), :TYPES) as r2 \gset
select pg_temp.ok('second sync changes nothing', (:'r2'::jsonb->>'inserted')::int = 0 and (:'r2'::jsonb->>'updated')::int = 7
  and (:'r2'::jsonb->>'shows_created')::int = 0 and (:'r2'::jsonb->>'shows_updated')::int = 0
  and (select count(*) from external_event_matches where status = 'pending') = 1 and (select count(*) from shows where source = 'csf') = 4);

-- ── Public data carries the credit ──
set session authorization authenticator; set role anon;
select pg_temp.ok('list_upcoming_shows: CSF credit, url, times, admission',
  exists (select 1 from jsonb_array_elements(list_upcoming_shows('{"limit":50}')) s
           where s->>'id' = 'show_csf1' and s->>'source' = 'csf' and s->>'attribution' = 'via The Card Shop Finder'
             and s->>'source_url' like 'https://thecardshopfinder.com/event/e1/?utm_source=%'
             and s->>'time_start' = '09:00' and (s->>'admission_price')::numeric = 10));
select pg_temp.ok('organizer''s linked show is credited too; plain shows say cardshow',
  exists (select 1 from jsonb_array_elements(list_upcoming_shows('{"limit":50}')) s where s->>'id' = 'org_monster' and s->>'attribution' is not null)
  and exists (select 1 from jsonb_array_elements(list_upcoming_shows('{"limit":50}')) s where s->>'id' = 'org_sac' and s->>'source' = 'cardshow' and s->>'source_url' is null));
select pg_temp.ok('null times and price stay out', (select not (r ? 'time_start') and not (r ? 'admission_price')
  from (select get_show_page((select slug from shows where id = 'show_csf4')) r) x));
select pg_temp.ok('anon reads events', (select count(*) from external_events) = 7);
do $$ begin perform 1 from external_sync_runs; raise notice 'FAIL  anon read the run log';
exception when insufficient_privilege then raise notice 'PASS  anon cannot read the run log'; end $$;
reset role; reset session authorization;

-- ── Security: organizers can't touch CSF shows ──
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-00000000000e';
do $$ begin update shows set name = 'Mine now' where id = 'show_csf1'; raise notice 'FAIL  organizer edited a CSF show';
exception when insufficient_privilege then raise notice 'PASS  organizer cannot edit a CSF show'; end $$;
do $$ begin update shows set external_event_id = null where id = 'org_monster'; raise notice 'FAIL  organizer unlinked';
exception when insufficient_privilege then raise notice 'PASS  organizer cannot change the link on their own show'; end $$;
do $$ begin insert into shows (id, name, source, created_by) values ('x', 'x', 'csf', 'eeeeeeee-0000-0000-0000-00000000000e'); raise notice 'FAIL  organizer made a csf show';
exception when insufficient_privilege then raise notice 'PASS  organizer cannot create a CSF show'; end $$;
select pg_temp.ok('organizer is not the organizer of a CSF show', not _show_inventory_is_organizer('show_csf1') and _show_inventory_is_organizer('org_sac'));
select pg_temp.ok('organizer cannot see the feed admin', csf_feed_admin()->>'error' = 'forbidden');
select pg_temp.ok('organizer cannot read run log or matches', (select count(*) from external_event_matches) = 0);
with u as (update shows set venue = 'Cal Expo Hall A' where id = 'org_monster' returning 1)
select pg_temp.ok('organizer still edits their own linked show', exists (select 1 from u));
-- Dealer A joins the Dallas CSF show (self-join is on) and picks it for pickup.
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('dealer joins a CSF show', (join_show_as_seller('show_csf1')->>'ok')::boolean);
reset role; reset session authorization;

insert into inventory (id, seller_id, card_title, player, year, card_set, card_number, grader, grade, cert_number, price, status) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Charizard PSA 10', 'Charizard', 1999, 'Base Set', '4', 'PSA', 10, '111', 180, 'Available'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Jayden Daniels PSA 9', 'Jayden Daniels', 2024, 'Prizm', '331', 'PSA', 9, '222', 250, 'Available'),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Draft card', 'X', 2024, 'Prizm', '1', null, null, null, 20, 'Available');
insert into card_captures (id, seller_id, entry_point, crop_key, uploaded_at)
select ('c' || substr(id::text, 2))::uuid, seller_id, 'case_scan', 'k/' || id || '/crop.jpg', now() from inventory;
update inventory set primary_capture_id = ('c' || substr(id::text, 2))::uuid, pickup_show_id = 'show_csf1', sale_modes = '{ship,pickup}';
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select publish_listings(array['a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002']::uuid[]);
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer C holds a card', (place_hold('a0000000-0000-0000-0000-000000000001', 'Cal', '555-0101', null)->>'ok')::boolean);
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('buyer D offers on the other', make_offer('a0000000-0000-0000-0000-000000000002', 20000, 'Dee', 'd@x.test')->>'status' = 'pending');
reset role; reset session authorization;
select pg_temp.ok('listing says pick up at the CSF show, with credit',
  (select _listing_json('a0000000-0000-0000-0000-000000000002')->'show'->>'attribution') = 'via The Card Shop Finder');

-- ── Dallas cancelled, Phoenix (today) ended, Monster event gone: one sync later ──
create temp table feed2 as select jsonb_build_array(
  pg_temp.ev(2, 'Pokemon League Cup', 'pokemon', 5, 5, 'Austin', 'TX'),
  pg_temp.ev(7, 'West Coast Hobby Expo Lakewood', 'card_show', 20, 21, 'Lakewood', 'CA'),
  pg_temp.ev(9, 'Capital City Comic Con', 'convention', 30, 30, 'Sacramento', 'CA'),
  pg_temp.ev(11, 'Houston Sports Card Show', 'sports', 40, 40, 'Houston', 'TX'),
  pg_temp.ev(13, 'New Orleans Card Show', 'card_show', 50, 50, 'New Orleans', 'LA')) as e;
select csf_sync_apply((select e from feed2), :TYPES) as r3 \gset
select pg_temp.ok('two removed, one ended', (:'r3'::jsonb->>'removed')::int = 2 and (:'r3'::jsonb->>'ended')::int = 1
  and (select status from external_events where source_event_id = 4) = 'ended');
select pg_temp.ok('ended show isn''t taken down', (select listed and feed_removed_at is null from shows where id = 'show_csf4'));
select pg_temp.ok('cancelled CSF show hidden', (select not listed and feed_removed_at is not null from shows where id = 'show_csf1'));
select pg_temp.ok('gone from upcoming shows and a card''s next show',
  not exists (select 1 from jsonb_array_elements(list_upcoming_shows('{"limit":50}')) s where s->>'id' = 'show_csf1')
  and _listing_json('a0000000-0000-0000-0000-000000000002')->'show' is null);
select pg_temp.ok('show page says removed', (get_show_page((select slug from shows where id = 'show_csf1'))->>'removed')::boolean);
select pg_temp.ok('pickup cleared, shipping kept', (select bool_and(pickup_show_id is null and 'ship' = any(sale_modes)) from inventory));
select pg_temp.ok('removal lists both listings, the hold and the offer',
  (select jsonb_array_length(listings) = 2 and jsonb_array_length(holds) = 1 and jsonb_array_length(offers) = 1
     from external_show_removals where show_id = 'show_csf1'));
select pg_temp.ok('emails queued: dealer A once, buyers C and D', (:'r3'::jsonb->>'notices_queued')::int = 3
  and (select count(*) from external_show_notices where to_kind = 'dealer') = 1 and (select count(*) from external_show_notices where to_kind = 'buyer') = 2);
select pg_temp.ok('dealer email lists both cards, hold and offer counts',
  (select jsonb_array_length(payload->'cards') = 2 and (payload->>'holds')::int = 1 and (payload->>'offers')::int = 1
     from external_show_notices where to_kind = 'dealer'));
select pg_temp.ok('hold and offer left alone', (select status from listing_reservations limit 1) = 'active'
  and (select status from offers limit 1) = 'pending');
select pg_temp.ok('organizer''s Monster show stays up, flagged', (select listed and feed_removed_at is null from shows where id = 'org_monster')
  and exists (select 1 from external_show_removals where show_id = 'org_monster' and kind = 'flagged'));
select pg_temp.ok('notices due carry emails and the url', (select count(*) from jsonb_array_elements(show_feed_notices_due(50)) n
  where n->>'email' is not null and n->>'source_url' like 'https://thecardshopfinder.com/event/e1/%') = 3);
select show_feed_notice_sent(id) from external_show_notices;
select pg_temp.ok('nothing due after sending', jsonb_array_length(show_feed_notices_due(50)) = 0);

-- ── Dallas comes back ──
create temp table feed3 as select (select e from feed2) || jsonb_build_array(pg_temp.ev(1, 'Dallas Card Show', 'card_show', 3, 4, 'Dallas', 'TX', 32.7767, -96.797)) as e;
select csf_sync_apply((select e from feed3), :TYPES) as r4 \gset
select pg_temp.ok('Dallas restored, no new emails', (:'r4'::jsonb->>'restored')::int = 1
  and (select listed and feed_removed_at is null from shows where id = 'show_csf1')
  and (select restored_at is not null from external_show_removals where show_id = 'show_csf1')
  and (select count(*) from external_show_notices) = 3);
-- … and leaves again: no second round of emails.
select csf_sync_apply((select e from feed2), :TYPES);
select pg_temp.ok('second removal: hidden again, still 3 emails', (select not listed from shows where id = 'show_csf1')
  and (select count(*) from external_show_notices) = 3);
select csf_sync_apply((select e from feed3), :TYPES);

-- ── Suspicious fetches change nothing ──
select csf_sync_apply(jsonb_build_array(pg_temp.ev(2, 'Pokemon League Cup', 'pokemon', 5, 5, 'Austin', 'TX')), :TYPES) as r5 \gset
select pg_temp.ok('one event of six: suspicious, nothing removed', (:'r5'::jsonb->>'suspicious')::boolean and (:'r5'::jsonb->>'removed')::int = 0
  and (select count(*) from external_events where status = 'active') = 6);
select csf_sync_apply('[]'::jsonb, :TYPES) as r6 \gset
select pg_temp.ok('empty feed: suspicious, nothing removed', (:'r6'::jsonb->>'suspicious')::boolean and (select listed from shows where id = 'show_csf1'));
insert into external_sync_runs (id, trigger) values ('11111111-0000-0000-0000-000000000001', 'manual');
select csf_sync_apply('[]'::jsonb, :TYPES, '11111111-0000-0000-0000-000000000001');
select pg_temp.ok('run row gets counts and the suspicious note', (select suspicious and error like 'Suspicious fetch%' from external_sync_runs
  where id = '11111111-0000-0000-0000-000000000001'));
select pg_temp.ok('a bad event is skipped, not fatal',
  (csf_sync_apply(jsonb_build_array(jsonb_build_object('id', 'x'), pg_temp.ev(1, 'Dallas Card Show', 'card_show', 3, 4, 'Dallas', 'TX'))
                  || (select e from feed2), :TYPES)->>'skipped')::int = 1);

-- ── Admin review ──
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'ffffffff-0000-0000-0000-00000000000f';
select pg_temp.ok('owner sees runs, the pending match and the removals',
  (select jsonb_array_length(a->'matches') = 1 and jsonb_array_length(a->'removals') = 2 and (a->'counts'->>'csf_shows')::int >= 4
     from (select csf_feed_admin() a) x));
select pg_temp.ok('owner rejects the WCHE match', (csf_resolve_match((select id from external_event_matches where status = 'pending'), 'reject')->>'ok')::boolean);
select pg_temp.ok('owner marks a removal handled', (csf_removal_handled((select id from external_show_removals where show_id = 'show_csf1'))->>'ok')::boolean);
with u as (update shows set website = 'https://example.test' where id = 'show_csf9' returning 1)
select pg_temp.ok('owner can edit a CSF show', exists (select 1 from u));
reset role; reset session authorization;
select csf_sync_apply((select e from feed3), :TYPES) as r7 \gset
select pg_temp.ok('after reject, the next sync makes WCHE its own show', exists (select 1 from shows where id = 'show_csf7' and source = 'csf')
  and (select external_event_id is null from shows where id = 'org_wche'));
-- A pending match the owner links.
insert into shows (id, name, start_date, end_date, venue, city, state, listed, created_by) values
  ('org_nola', 'NOLA Card Show', current_date + 50, current_date + 50, 'Hall', 'Metairie', 'LA', true, 'eeeeeeee-0000-0000-0000-00000000000e');
delete from shows where id = 'show_csf13';
select csf_sync_apply((select e from feed3), :TYPES);
select pg_temp.ok('NOLA (other city) waits for review', exists (select 1 from external_event_matches where show_id = 'org_nola' and status = 'pending'));
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'ffffffff-0000-0000-0000-00000000000f';
select csf_resolve_match((select id from external_event_matches where show_id = 'org_nola'), 'link') as lk \gset
select pg_temp.ok('owner links it', (:'lk'::jsonb->>'status') = 'linked'
  and (select external_event_id is not null from shows where id = 'org_nola'));
reset role; reset session authorization;
select pg_temp.ok('linked show not duplicated next sync', (csf_sync_apply((select e from feed3), :TYPES)->>'shows_created')::int = 0
  and not exists (select 1 from shows where id = 'show_csf13'));
