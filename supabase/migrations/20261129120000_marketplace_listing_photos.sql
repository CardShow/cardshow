-- Marketplace: every listing needs a photo of the actual card. Re-runnable.
-- Run after 20261122120000_marketplace_listings.sql (and the Show Mode sales migration, which created
-- card_captures and inventory.primary_capture_id). See CLAUDE.md "Dealer listing controls".
--
-- publish_listings() now also skips:
--   no_photo        the card has no seller photo (inventory.primary_capture_id empty, or that photo deleted)
--   photo_uploading the photo exists but hasn't finished uploading from the phone yet
-- Sealed product (item_type = 'sealed') is exempt: every box looks the same, so a catalog image is enough.
-- Lots and single cards always need a photo. A catalog (CardSight) image never counts as the photo.
-- Cards already listed stay listed; the check runs when a card is listed.

begin;

create or replace function public._listing_photo_state(p_capture_id text) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_row record;
begin
  if p_capture_id is null or p_capture_id = '' then return 'no_photo'; end if;
  if to_regclass('public.card_captures') is null then return 'no_photo'; end if;
  execute 'select crop_key, uploaded_at, deleted_at from public.card_captures where id = $1::uuid'
    into v_row using p_capture_id;
  if v_row is null or v_row.deleted_at is not null or v_row.crop_key is null then return 'no_photo'; end if;
  if v_row.uploaded_at is null then return 'photo_uploading'; end if;
  return null;
end $$;
revoke all on function public._listing_photo_state(text) from public, anon, authenticated;

create or replace function public.publish_listings(p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_ok uuid[] := '{}'; v_skip jsonb := '[]'::jsonb; r record; v_why text;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then return jsonb_build_object('ok', true, 'published', '[]'::jsonb, 'skipped', '[]'::jsonb); end if;
  if cardinality(p_ids) > 1000 then raise exception 'too_many'; end if;
  perform set_config('cardshow.listing_fn', 'on', true);
  for r in select i.*, to_jsonb(i) j from public.inventory i
            where i.id = any(p_ids) and i.seller_id = v_uid order by i.id for update loop
    v_why := case
      when r.status = 'Sold' or r.listing_status = 'sold' then 'sold'
      when r.listing_status = 'reserved' then 'reserved'
      when r.j->>'trust_flag' in ('flagged','disputed') then 'trust_flag'
      when r.j->>'identification_status' = 'unidentified' then 'needs_details'
      when coalesce(r.price, 0) <= 0 then 'no_price'
      when coalesce(r.j->>'item_type', 'card') = 'sealed' then null
      else public._listing_photo_state(r.j->>'primary_capture_id') end;
    if v_why is not null then
      v_skip := v_skip || jsonb_build_object('id', r.id, 'reason', v_why);
    else
      if r.listing_status <> 'active' then
        update public.inventory set listing_status = 'active' where id = r.id;
        perform public._listing_log(array[r.id], v_uid, 'published', r.listing_status, 'active', null, 'dealer', v_uid::text, null);
      end if;
      v_ok := v_ok || r.id;
    end if;
  end loop;
  select v_skip || coalesce(jsonb_agg(jsonb_build_object('id', x, 'reason', 'not_found')), '[]'::jsonb) into v_skip
    from unnest(p_ids) x where not exists (select 1 from public.inventory i where i.id = x and i.seller_id = v_uid);
  perform set_config('cardshow.listing_fn', 'off', true);
  return jsonb_build_object('ok', true, 'published', to_jsonb(v_ok), 'skipped', v_skip);
end $$;

revoke all on function public.publish_listings(uuid[]) from public, anon;
grant execute on function public.publish_listings(uuid[]) to authenticated;

commit;

-- Check (run after): a card with no photo is skipped with reason no_photo.
--   select public.publish_listings(array['<a card id with no photo>'::uuid]);   -- as that seller
