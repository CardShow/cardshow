-- Marketplace photo requirement (20261129120000_marketplace_listing_photos.sql). Run with marketplace-photos.test.sh.
\set ON_ERROR_STOP 1
alter table inventory add column if not exists sold_date text, add column if not exists sale_notes text;
alter table show_floor_transactions
  add column if not exists api_eligible boolean default true, add column if not exists card_title text,
  add column if not exists item_type text, add column if not exists client_sale_id uuid;
\i ../../supabase/migrations/20261023120000_show_mode_sales.sql
\i ../../supabase/migrations/20261122120000_marketplace_listings.sql
\i ../../supabase/migrations/20261129120000_marketplace_listing_photos.sql
\i ../../supabase/migrations/20261129120000_marketplace_listing_photos.sql
grant all on all tables in schema public to anon, authenticated, service_role;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;

insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001');
insert into sellers values ('aaaaaaaa-0000-0000-0000-000000000001', 'dealer_a');
insert into card_captures (id, seller_id, entry_point, crop_key, uploaded_at, deleted_at) values
  ('c0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'case_scan', 'k/1/crop.jpg', now(), null),
  ('c0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'case_scan', 'k/2/crop.jpg', null,  null),
  ('c0000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'case_scan', 'k/3/crop.jpg', now(), now());
insert into inventory (id, seller_id, card_title, price, status, item_type, primary_capture_id) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'photo uploaded', 100, 'Available', 'card', 'c0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'no photo', 100, 'Available', 'card', null),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'still uploading', 100, 'Available', 'card', 'c0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'photo deleted', 100, 'Available', 'card', 'c0000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'sealed box', 100, 'Available', 'sealed', null),
  ('a0000000-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'lot', 100, 'Available', 'lot', null),
  ('a0000000-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 'no photo, no price', 0, 'Available', 'card', null);
insert into inventory (id, seller_id, card_title, price, status, item_type, grader, grade, cert_number, stock_image_id, primary_capture_id) values
  ('a0000000-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001', 'raw + catalog image', 50, 'Available', 'card', null, null, null, 'd0000000-0000-0000-0000-000000000001', null),
  ('a0000000-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', 'slab + catalog image only', 500, 'Available', 'card', 'PSA', 10, '12345', 'd0000000-0000-0000-0000-000000000002', null),
  ('a0000000-0000-0000-0000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000001', 'cert, no grader + catalog', 500, 'Available', 'card', '', null, '999', 'd0000000-0000-0000-0000-000000000003', null),
  ('a0000000-0000-0000-0000-000000000014', 'aaaaaaaa-0000-0000-0000-000000000001', 'raw (grader Raw) + catalog', 20, 'Available', 'card', 'Raw', null, null, 'd0000000-0000-0000-0000-000000000004', null),
  ('a0000000-0000-0000-0000-000000000015', 'aaaaaaaa-0000-0000-0000-000000000001', 'slab + photo uploaded', 300, 'Available', 'card', 'BGS', 9.5, '777', null, 'c0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000016', 'aaaaaaaa-0000-0000-0000-000000000001', '2018 Leaf NSC Shohei Ohtani Rookie TAG', 80, 'Available', 'card', null, null, null, 'd0000000-0000-0000-0000-000000000005', null),
  ('a0000000-0000-0000-0000-000000000017', 'aaaaaaaa-0000-0000-0000-000000000001', '2020 Prizm Joe Burrow psa 10', 80, 'Available', 'card', null, null, null, 'd0000000-0000-0000-0000-000000000006', null),
  ('a0000000-0000-0000-0000-000000000018', 'aaaaaaaa-0000-0000-0000-000000000001', '2021 Topps Tag Team Insert', 10, 'Available', 'card', null, null, null, 'd0000000-0000-0000-0000-000000000007', null);
\set ON_ERROR_STOP 0

set session authorization authenticator;
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
create temp table p as select public.publish_listings(array[
  'a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000003',
  'a0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000006',
  'a0000000-0000-0000-0000-000000000007','a0000000-0000-0000-0000-000000000011','a0000000-0000-0000-0000-000000000012',
  'a0000000-0000-0000-0000-000000000013','a0000000-0000-0000-0000-000000000014','a0000000-0000-0000-0000-000000000015',
  'a0000000-0000-0000-0000-000000000016','a0000000-0000-0000-0000-000000000017','a0000000-0000-0000-0000-000000000018']::uuid[]) j;
create temp view sk as select e->>'id' id, e->>'reason' reason from p, jsonb_array_elements(p.j->'skipped') e;

select case when (select j->'published' from p) @> '["a0000000-0000-0000-0000-000000000001"]'
  and (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 'active'
  then 'PASS 1 card with an uploaded photo is listed' else 'FAIL 1 ' || (select j::text from p) end;
select case when (select reason from sk where id = 'a0000000-0000-0000-0000-000000000002') = 'no_photo'
  and (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000002') = 'draft'
  then 'PASS 2 card with no photo is skipped (no_photo)' else 'FAIL 2' end;
select case when (select reason from sk where id = 'a0000000-0000-0000-0000-000000000003') = 'photo_uploading'
  then 'PASS 3 photo not uploaded yet: photo_uploading' else 'FAIL 3' end;
select case when (select reason from sk where id = 'a0000000-0000-0000-0000-000000000004') = 'no_photo'
  then 'PASS 4 deleted photo counts as no photo' else 'FAIL 4' end;
select case when (select j->'published' from p) @> '["a0000000-0000-0000-0000-000000000005"]'
  then 'PASS 5 sealed product lists without a photo' else 'FAIL 5' end;
select case when (select reason from sk where id = 'a0000000-0000-0000-0000-000000000006') = 'no_photo'
  then 'PASS 6 a lot needs a photo' else 'FAIL 6' end;
select case when (select reason from sk where id = 'a0000000-0000-0000-0000-000000000007') = 'no_price'
  then 'PASS 7 price is checked before the photo' else 'FAIL 7' end;
select case when not has_function_privilege('authenticated', 'public._listing_photo_state(text)', 'execute')
  then 'PASS 8 photo helper not callable from the app' else 'FAIL 8' end;

select case when (select j->'published' from p) @> '["a0000000-0000-0000-0000-000000000011","a0000000-0000-0000-0000-000000000014"]'
  then 'PASS 10 raw card lists with a catalog image the seller picked' else 'FAIL 10' end;
select case when (select reason from sk where id = 'a0000000-0000-0000-0000-000000000012') = 'no_photo'
  and (select reason from sk where id = 'a0000000-0000-0000-0000-000000000013') = 'no_photo'
  then 'PASS 11 graded card (grader or cert #) needs a photo of the slab; catalog image does not count' else 'FAIL 11' end;
select case when (select j->'published' from p) @> '["a0000000-0000-0000-0000-000000000015"]'
  then 'PASS 12 graded card with its own photo lists' else 'FAIL 12' end;
select case when not has_function_privilege('authenticated', 'public._listing_image_state(jsonb)', 'execute')
  then 'PASS 13 image helper not callable from the app' else 'FAIL 13' end;

select case when (select reason from sk where id = 'a0000000-0000-0000-0000-000000000016') = 'no_photo'
  and (select reason from sk where id = 'a0000000-0000-0000-0000-000000000017') = 'no_photo'
  then 'PASS 14 grader named in the title ("Rookie TAG", "psa 10") counts as graded' else 'FAIL 14' end;
select case when (select j->'published' from p) @> '["a0000000-0000-0000-0000-000000000018"]'
  then 'PASS 15 ordinary word "Tag" in a title does not make a card graded' else 'FAIL 15' end;

-- 9. Once the photo finishes uploading, the card lists.
reset role; reset session authorization;
update card_captures set uploaded_at = now() where id = 'c0000000-0000-0000-0000-000000000002';
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select case when (public.publish_listings(array['a0000000-0000-0000-0000-000000000003']::uuid[]))->'published'
  @> '["a0000000-0000-0000-0000-000000000003"]' then 'PASS 9 lists once the upload finishes' else 'FAIL 9' end;
