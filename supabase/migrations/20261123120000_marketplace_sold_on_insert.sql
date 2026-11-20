-- CardShow Marketplace, Phase 0 follow-up: cards created already sold. Re-runnable.
-- Run after 20261122120000_marketplace_listings.sql.
--
-- Log a Manual Sale and Show Mode's "Log a sale" (record_sale with p_new_item) insert a card
-- with status 'Sold'. The sync trigger only watched UPDATEs into 'Sold', so those cards stayed
-- listing_status 'draft'. Harmless for buyers (drafts are never listed) but wrong. This file:
-- 1. makes the sync trigger also run on INSERT, so a card created sold is marked sold;
-- 2. marks every card that is already Sold but still draft as sold (sold before the marketplace
--    migration, or created sold since). sold_at is left empty: the real sale time isn't known.

begin;

create or replace function public._inv_listing_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_res uuid;
begin
  -- Created already sold (manual sale, Show Mode "Log a sale", imports).
  if tg_op = 'INSERT' then
    if new.status = 'Sold' and new.listing_status = 'draft' then
      new.listing_status_before_sale := 'draft';
      new.listing_status := 'sold';
      new.sold_at := coalesce(new.sold_at, now());
      new.sold_channel := coalesce(new.sold_channel, 'in_person');
    end if;
    return new;
  end if;

  -- Sold by any existing path (table sale, Show Mode, trade, import).
  if new.status = 'Sold' and old.status is distinct from 'Sold' and new.listing_status <> 'sold' then
    v_res := new.reservation_id;
    new.listing_status_before_sale := new.listing_status;
    new.listing_status := 'sold';
    new.sold_at := coalesce(new.sold_at, now());
    new.sold_channel := coalesce(new.sold_channel, 'in_person');
    if v_res is not null then
      update public.listing_reservations set status = 'broken', ended_at = now(), end_reason = 'sold_elsewhere'
       where id = v_res and status = 'active';
      perform public._listing_log(array[new.id], new.seller_id, 'reservation_broken', 'reserved', 'sold', v_res, 'system', null,
                                  jsonb_build_object('sold_channel', new.sold_channel));
    end if;
    new.reserved_until := null; new.reserved_by := null; new.reservation_id := null;
    perform public._listing_log(array[new.id], new.seller_id, 'sold_outside', new.listing_status_before_sale, 'sold', null, 'dealer',
                                new.seller_id::text, jsonb_build_object('sold_channel', new.sold_channel));
    return new;
  end if;

  -- Undo of such a sale. A hold that was broken is not restored; a marketplace sale is not relisted.
  if old.status = 'Sold' and new.status is distinct from 'Sold' and new.listing_status = 'sold' then
    new.listing_status := case
      when coalesce(new.sold_channel, 'in_person') <> 'in_person' then 'delisted'
      when new.listing_status_before_sale = 'reserved' then 'active'
      else coalesce(new.listing_status_before_sale, 'draft') end;
    new.sold_at := null; new.sold_channel := null; new.listing_status_before_sale := null;
    perform public._listing_log(array[new.id], new.seller_id, 'sale_undone', 'sold', new.listing_status, null, 'dealer', new.seller_id::text, null);
  end if;

  -- A stolen/lost report takes an active listing down (reserved cards are refused at mark_sold).
  if new.listing_status = 'active' and to_jsonb(new)->>'trust_flag' = 'flagged'
     and to_jsonb(old)->>'trust_flag' is distinct from 'flagged' then
    new.listing_status := 'delisted';
    perform public._listing_log(array[new.id], new.seller_id, 'delisted_trust_flag', 'active', 'delisted', null, 'system', null, null);
  end if;
  return new;
end $$;

drop trigger if exists inv_listing_b_sync on public.inventory;
create trigger inv_listing_b_sync before insert or update on public.inventory
  for each row execute function public._inv_listing_sync();

-- Backfill: Sold cards still marked draft. The listing functions' flag lets this through the guard
-- whatever role runs it.
select set_config('cardshow.listing_fn', 'on', true);
update public.inventory
   set listing_status = 'sold', sold_channel = 'in_person', listing_status_before_sale = 'draft'
 where status = 'Sold' and listing_status = 'draft';
select set_config('cardshow.listing_fn', 'off', true);

commit;
