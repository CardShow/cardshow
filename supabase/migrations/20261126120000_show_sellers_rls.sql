-- show_sellers security: only a show's organizer adds, edits or removes its sellers. Re-runnable.
-- See CLAUDE.md "show_sellers security". Run after 20261125120000_show_inventory_rls.sql (uses its
-- _show_inventory_is_organizer() helper).
--
-- Before: the dashboard-made policies let anyone (anon included) add themselves or anyone else to
-- any show, change table numbers or remove sellers. Since show_inventory lets a seller publish to a
-- show they're in, that also let anyone publish into any show. After:
-- * Reading stays public (show.html's seller list and table numbers, buyer Find a Table, floor map).
-- * Insert / update / delete: the show's organizer only (shows.created_by, any admin for a show with
--   no created_by, or a platform owner). Covers adding/removing sellers, table numbers, floor-map pins.
-- * Sellers join and leave only through join_show_as_seller() / leave_show_as_seller(), which check
--   the self-join switch, listing and dates. Those, merge_shows(), delete_show() and
--   resolve_show_request() are SECURITY DEFINER and bypass RLS, as before.
--
-- To see the policies this replaces, run before applying:
--   select policyname, cmd, roles, qual, with_check from pg_policies
--    where schemaname = 'public' and tablename = 'show_sellers';

begin;

do $$ begin
  if to_regprocedure('public._show_inventory_is_organizer(text)') is null then
    raise exception 'Run 20261125120000_show_inventory_rls.sql first';
  end if;
end $$;

alter table public.show_sellers enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'show_sellers' loop
    execute format('drop policy %I on public.show_sellers', p.policyname);
  end loop;
end $$;

create policy show_sellers_read_all on public.show_sellers
  for select to anon, authenticated using (true);
create policy show_sellers_insert_organizer on public.show_sellers
  for insert to authenticated with check (public._show_inventory_is_organizer(show_id));
create policy show_sellers_update_organizer on public.show_sellers
  for update to authenticated
  using (public._show_inventory_is_organizer(show_id))
  with check (public._show_inventory_is_organizer(show_id));
create policy show_sellers_delete_organizer on public.show_sellers
  for delete to authenticated using (public._show_inventory_is_organizer(show_id));

revoke insert, update, delete, truncate on public.show_sellers from anon;

commit;

-- Check (run after): expect exactly the four policies above.
--   select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'show_sellers';
