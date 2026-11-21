-- Marketplace Phase 1: buyer site support. Re-runnable.
-- Run after 20261130120000_marketplace_pricing_search.sql (and 20261202120000_pricing_admin.sql).
--
-- 1. Public listing photos. Seller photos live in the private card-captures bucket. When a card is listed,
--    netlify/functions/sync-listing-photos.js copies its photo to the public listing-photos bucket
--    (listing-photos/<card id>/<capture id>.jpg) and records it here; when the card is delisted, sold or
--    flagged, or the photo is replaced, the public copy is deleted. Only the service role writes these columns.
-- 2. _listing_json() returns image.photo_path, and the dealer's WhatsApp / Instagram on the listing page
--    (p_detail), so a buyer can contact the dealer before checkout exists.

begin;

alter table public.inventory
  add column if not exists public_photo_path text,
  add column if not exists public_photo_capture_id uuid;

-- Only the service role / database functions set the public photo.
create or replace function public._inv_public_photo_guard() returns trigger
language plpgsql as $$
begin
  if public._listing_write_allowed() or public._listing_is_service() then return new; end if;
  if tg_op = 'INSERT' then
    if new.public_photo_path is not null or new.public_photo_capture_id is not null then
      raise exception 'public_photo_is_server_managed';
    end if;
  elsif new.public_photo_path is distinct from old.public_photo_path
     or new.public_photo_capture_id is distinct from old.public_photo_capture_id then
    raise exception 'public_photo_is_server_managed';
  end if;
  return new;
end $$;
drop trigger if exists inv_public_photo_guard on public.inventory;
create trigger inv_public_photo_guard before insert or update of public_photo_path, public_photo_capture_id
  on public.inventory for each row execute function public._inv_public_photo_guard();

-- Public bucket: anyone reads, nobody but the service role writes.
insert into storage.buckets (id, name, public)
values ('listing-photos', 'listing-photos', true)
on conflict (id) do update set public = true;
drop policy if exists listing_photos_public_read on storage.objects;
create policy listing_photos_public_read on storage.objects for select
  using (bucket_id = 'listing-photos');

-- Work for the photo sync. add = listed cards whose current seller photo isn't public yet (or was replaced);
-- remove = public photos that must go (not listed any more, flagged, or the seller removed the photo).
-- p_ids limits it to those cards (the dealer app asks right after listing).
create or replace function public.listing_photos_due(p_ids uuid[] default null, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_add jsonb; v_remove jsonb;
begin
  perform public._require_service();
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'capture_id', x.capture_id, 'key', x.key, 'old_path', x.old_path)), '[]'::jsonb)
    into v_add
    from (select i.id, c.id as capture_id, coalesce(nullif(c.crop_key, ''), c.original_key) as key, i.public_photo_path as old_path
            from public.inventory i
            join public.card_captures c on c.id = i.primary_capture_id
           where i.listing_status in ('active','reserved')
             and coalesce(to_jsonb(i)->>'trust_flag', '') not in ('flagged','disputed')
             and c.uploaded_at is not null and c.deleted_at is null
             and coalesce(nullif(c.crop_key, ''), c.original_key) is not null
             and i.public_photo_capture_id is distinct from c.id
             and (p_ids is null or i.id = any(p_ids))
           order by i.listed_at nulls last
           limit least(greatest(coalesce(p_limit, 50), 1), 500)) x;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'old_path', x.public_photo_path)), '[]'::jsonb)
    into v_remove
    from (select i.id, i.public_photo_path
            from public.inventory i
            left join public.card_captures c on c.id = i.primary_capture_id
           where i.public_photo_path is not null
             and (i.listing_status not in ('active','reserved')
                  or coalesce(to_jsonb(i)->>'trust_flag', '') in ('flagged','disputed')
                  or i.primary_capture_id is null or c.id is null or c.deleted_at is not null)
             and (p_ids is null or i.id = any(p_ids))
           limit least(greatest(coalesce(p_limit, 50), 1), 500)) x;
  return jsonb_build_object('add', v_add, 'remove', v_remove);
end $$;

-- Record (or clear, with p_path null) a card's public photo. Returns the path it replaced, for deletion.
create or replace function public.listing_photo_set(p_id uuid, p_capture_id uuid, p_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  perform public._require_service();
  select public_photo_path into v_old from public.inventory where id = p_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  perform set_config('cardshow.listing_fn', 'on', true);
  update public.inventory set public_photo_path = nullif(p_path, ''),
         public_photo_capture_id = case when nullif(p_path, '') is null then null else p_capture_id end
   where id = p_id;
  perform set_config('cardshow.listing_fn', 'off', true);
  return jsonb_build_object('ok', true, 'old_path', case when v_old is distinct from nullif(p_path, '') then v_old end);
end $$;

revoke all on function public.listing_photos_due(uuid[], int), public.listing_photo_set(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.listing_photos_due(uuid[], int), public.listing_photo_set(uuid, uuid, text) to service_role;

-- One listing as the public sees it. Same as 20261130120000 plus image.photo_path and, on the listing
-- page (p_detail), the dealer's WhatsApp and Instagram.
create or replace function public._listing_json(p_id uuid, p_detail boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  i record; j jsonb; s jsonb; v_deal numeric; v_few int; v_graded boolean;
  v_low int; v_high int; v_sales int; v_change numeric; v_source text; v_photo text;
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
  select to_jsonb(x) into s from public.sellers x where x.id = i.seller_id;
  -- The public copy only counts while it's still the card's current photo.
  v_photo := case when i.public_photo_path is not null and i.public_photo_capture_id = i.primary_capture_id
                  then i.public_photo_path end;
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
        'photo_path', v_photo,
        'stock_image_url', case when nullif(j->>'stock_image_id', '') is not null
                                then '/.netlify/functions/card-image?id=' || (j->>'stock_image_id') end,
        'catalog_image', v_photo is null and nullif(j->>'stock_image_id', '') is not null,
        'has_photo', nullif(j->>'primary_capture_id', '') is not null)),
    'dealer', jsonb_strip_nulls(jsonb_build_object(
        'handle', s->>'handle', 'display_name', coalesce(nullif(s->>'display_name', ''), s->>'handle'),
        'url', '/d/' || coalesce(s->>'handle', ''),
        'whatsapp', case when p_detail then nullif(regexp_replace(coalesce(s->>'whatsapp', ''), '[^0-9]', '', 'g'), '') end,
        'instagram', case when p_detail then nullif(ltrim(coalesce(s->>'instagram', ''), '@ '), '') end)),
    'show', public._listing_next_show(i.id, i.pickup_show_id),
    'listed_at', i.listed_at,
    'features', case when p_detail then j->'features' end,
    'serial_number', case when p_detail then j->>'serial_number' end,
    'print_run_size', case when p_detail then j->'print_run_size' end
  ));
end $$;
revoke all on function public._listing_json(uuid, boolean) from public, anon, authenticated;

commit;
