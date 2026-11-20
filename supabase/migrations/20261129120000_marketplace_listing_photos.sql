-- Marketplace: every listing needs an image. Re-runnable.
-- Run after 20261122120000_marketplace_listings.sql (and the Show Mode sales migration, which created
-- card_captures and inventory.primary_capture_id). See CLAUDE.md "Card photos".
--
-- What counts:
--   * Graded cards (a grader other than Raw, a cert #, or a grader named in the title, like "Rookie TAG"
--     or "psa 10"): only the seller's photo of the exact slab,
--     because buyers match the cert number. A catalog image never counts.
--   * Raw cards and lots: the seller's photo, or a catalog image the seller picked as the
--     representative image (inventory.stock_image_id, set from Edit Card → "Use a catalog image").
--     Lots are never offered catalog images in the app, so in practice they need a photo.
--   * Sealed product (item_type = 'sealed'): no image needed.
-- publish_listings() skips:
--   no_photo        nothing that counts (no photo, photo deleted, or a graded card with only a catalog image)
--   photo_uploading the only qualifying image is a seller photo that hasn't finished uploading yet
-- Cards already listed stay listed; the check runs when a card is listed.

begin;

-- The catalog (CardSight) card id the seller picked as this card's representative image. Only set by
-- the seller's own choice, unlike catalog_card_id, which identification and comp checks also fill in.
alter table public.inventory add column if not exists stock_image_id text;

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

-- null when the card has an image that counts for listing, else 'no_photo' / 'photo_uploading'.
create or replace function public._listing_image_state(p_card jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_photo text; v_graded boolean;
begin
  if coalesce(p_card->>'item_type', 'card') = 'sealed' then return null; end if;
  v_photo := public._listing_photo_state(p_card->>'primary_capture_id');
  if v_photo is null then return null; end if;
  v_graded := (nullif(trim(coalesce(p_card->>'grader', '')), '') is not null
               and lower(trim(p_card->>'grader')) <> 'raw')
              or nullif(trim(coalesce(p_card->>'cert_number', '')), '') is not null
              -- same rule as cpTitleGrader() in js/card-photo.js
              or coalesce(p_card->>'card_title', '') ~ '\m(PSA|BGS|BVG|SGC|CGC|TAG|HGA|GMA|CSG|AGS|ISA)\M'
              or coalesce(p_card->>'card_title', '') ~* '\m(psa|bgs|bvg|sgc|cgc|tag|hga|gma|csg)\s?(10|[1-9](\.5)?)\M';
  if not v_graded and nullif(trim(coalesce(p_card->>'stock_image_id', '')), '') is not null then return null; end if;
  return v_photo;
end $$;
revoke all on function public._listing_image_state(jsonb) from public, anon, authenticated;

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
      else public._listing_image_state(r.j) end;
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

-- Check (run after): a card with no image is skipped with reason no_photo.
--   select public.publish_listings(array['<a card id with no photo>'::uuid]);   -- as that seller
