-- show_inventory security: who can put a card in a show, or take it out. Re-runnable.
-- See CLAUDE.md "show_inventory security". Run after 20261124120000_inventory_rls.sql.
--
-- Before: the dashboard-made policies let anyone (anon included) add any card to any show or
-- remove it. After:
-- * Reading stays public (show.html, seller-browse.html, the buyer view and live sync read as anon).
-- * Add a card to a show (insert; also the update half of the app's upserts):
--     - the card's seller, if they are a seller in that show (show_sellers), or
--     - the show's organizer (shows.created_by, or any admin for a show with no created_by) or the
--       platform owner, for a card whose seller is in that show.
-- * Remove a card from a show (delete): the card's seller (any show), the show's organizer, or the
--   platform owner.
-- Unaffected: the service role (GTCR function) and SECURITY DEFINER functions (record_sale,
-- leave_show_as_seller, merge_shows, delete_show) bypass RLS. record_trade / delete_dealer_trade
-- run as the seller and only touch the seller's own cards in a show they're in.
--
-- To see the policies this replaces, run before applying:
--   select policyname, cmd, roles, qual, with_check from pg_policies
--    where schemaname = 'public' and tablename = 'show_inventory';

begin;

-- The show's organizer or the platform owner. SECURITY DEFINER so it reads shows / admins /
-- platform_admins whatever their own policies are.
create or replace function public._show_inventory_is_organizer(p_show_id text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_owner uuid; v_found boolean;
begin
  if v_uid is null then return false; end if;
  if to_regclass('public.platform_admins') is not null then
    execute 'select exists (select 1 from public.platform_admins where id = $1)' into v_found using v_uid;
    if v_found then return true; end if;
  end if;
  select (to_jsonb(s)->>'created_by')::uuid into v_owner from public.shows s where s.id = p_show_id;
  if not found then return false; end if;
  if v_owner is not null then return v_owner = v_uid; end if;
  if to_regclass('public.admins') is null then return false; end if;
  execute 'select exists (select 1 from public.admins where id = $1)' into v_found using v_uid;
  return v_found;
end $$;

-- May the caller add this card to this show?
create or replace function public._show_inventory_can_add(p_show_id text, p_card_id uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_seller uuid;
begin
  if v_uid is null then return false; end if;
  select seller_id into v_seller from public.inventory where id = p_card_id;
  if v_seller is null then return false; end if;
  if not exists (select 1 from public.show_sellers where show_id = p_show_id and seller_id = v_seller) then
    return false;
  end if;
  return v_seller = v_uid or public._show_inventory_is_organizer(p_show_id);
end $$;

-- May the caller take this card out of this show?
create or replace function public._show_inventory_can_remove(p_show_id text, p_card_id uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  if exists (select 1 from public.inventory where id = p_card_id and seller_id = v_uid) then return true; end if;
  return public._show_inventory_is_organizer(p_show_id);
end $$;

revoke all on function public._show_inventory_is_organizer(text) from public;
revoke all on function public._show_inventory_can_add(text, uuid) from public;
revoke all on function public._show_inventory_can_remove(text, uuid) from public;
grant execute on function public._show_inventory_is_organizer(text) to authenticated;
grant execute on function public._show_inventory_can_add(text, uuid) to authenticated;
grant execute on function public._show_inventory_can_remove(text, uuid) to authenticated;

alter table public.show_inventory enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'show_inventory' loop
    execute format('drop policy %I on public.show_inventory', p.policyname);
  end loop;
end $$;

create policy show_inventory_read_all on public.show_inventory
  for select to anon, authenticated using (true);
create policy show_inventory_insert on public.show_inventory
  for insert to authenticated with check (public._show_inventory_can_add(show_id, card_id));
-- The app publishes with upsert(onConflict show_id,card_id); an existing row becomes an UPDATE.
create policy show_inventory_update on public.show_inventory
  for update to authenticated
  using (public._show_inventory_can_add(show_id, card_id))
  with check (public._show_inventory_can_add(show_id, card_id));
create policy show_inventory_delete on public.show_inventory
  for delete to authenticated using (public._show_inventory_can_remove(show_id, card_id));

revoke insert, update, delete, truncate on public.show_inventory from anon;

-- Undoing a trade puts its cards back on the trade's show. If the seller has since left that show,
-- skip that step instead of failing the whole undo (same function as in 20261121120000_trade_logging.sql
-- plus the where clause). Skipped if the trade migration hasn't run.
do $outer$ begin
if to_regclass('public.dealer_transactions') is not null then
execute $fn$
create or replace function public.delete_dealer_trade(p_txn_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_txn record; v_moved text; v_ins uuid[]; v_outs uuid[];
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_txn from public.dealer_transactions where id = p_txn_id and owner_id = v_uid for update;
  if v_txn.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if v_txn.txn_type not in ('trade', 'buy') then return jsonb_build_object('error', 'not_a_trade'); end if;

  select coalesce(array_agg(inventory_id) filter (where direction = 'in'), '{}'),
         coalesce(array_agg(inventory_id) filter (where direction = 'out'), '{}')
    into v_ins, v_outs
    from public.transaction_items where dealer_txn_id = p_txn_id and inventory_id is not null;

  select coalesce(i.stock_code, i.card_title, 'a card') into v_moved
    from public.inventory i where i.id = any(v_ins) and i.status = 'Sold' limit 1;
  if v_moved is not null then return jsonb_build_object('error', 'card_moved_on', 'title', v_moved); end if;

  delete from public.dealer_transactions where id = p_txn_id;      -- its items and item costs cascade
  delete from public.inventory where id = any(v_ins) and seller_id = v_uid;
  update public.inventory set status = 'Available' where id = any(v_outs) and seller_id = v_uid;
  perform public._import_update_inventory(x, jsonb_build_object('sold_price', null, 'payment_method', null,
                                                                'sold_date', null, 'sold_time', null))
     from unnest(v_outs) x;
  -- record_trade took them off the buyer pages; put them back on the trade's show.
  if v_txn.show_id is not null then
    insert into public.show_inventory (show_id, card_id)
    select v_txn.show_id, x from unnest(v_outs) x
     where public._show_inventory_can_add(v_txn.show_id, x)   -- not if the seller has left the show
    on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true, 'restored', to_jsonb(v_outs), 'removed', to_jsonb(v_ins));
end;
$$;
$fn$;
end if;
end $outer$;

commit;

-- Check (run after): expect exactly the four policies above.
--   select policyname, cmd, roles from pg_policies where schemaname = 'public' and tablename = 'show_inventory';
