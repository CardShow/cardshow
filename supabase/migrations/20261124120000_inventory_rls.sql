-- Inventory security (Tier 1): sellers can only change their own cards. Re-runnable.
-- See CLAUDE.md "Inventory security". Run after 20261122120000_marketplace_listings.sql.
--
-- Before: inventory's policies (made by hand in the dashboard) let any signed-in user, and anon,
-- write any row. After:
-- * Reading stays public (buyer pages, show.html, seller-browse.html, live sync all read as anon).
-- * Insert / update / delete: signed-in users, only rows where seller_id = auth.uid(); a card can't
--   be moved to another seller.
-- * GTCR trust fields (trust_flag, trust_clear_at, trust_recheck_at) can't be set by sellers. Only
--   the GTCR functions (service key) and database functions write them. A seller edit may still
--   clear trust_clear_at / trust_recheck_at, which the cert-change trigger does when a cert # or
--   grader is edited.
-- Unaffected: the service role (Netlify functions) and SECURITY DEFINER functions (record_sale,
-- void_sale, listing functions, show admin) bypass RLS as before. SECURITY INVOKER functions
-- (record_trade, import_show_log, stock codes) already only touch the caller's own cards.
--
-- To see the policies this replaces, run before applying:
--   select policyname, cmd, roles, qual, with_check from pg_policies
--    where schemaname = 'public' and tablename = 'inventory';
-- To undo (back to fully open writes, NOT recommended):
--   drop policy inventory_insert_own on public.inventory; ... and create permissive
--   insert/update/delete policies using (true) / with check (true) again.

begin;

alter table public.inventory enable row level security;

-- Drop every existing policy on inventory (names were set by hand in the dashboard, so they
-- aren't known here), then create the four below.
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'inventory' loop
    execute format('drop policy %I on public.inventory', p.policyname);
  end loop;
end $$;

create policy inventory_read_all on public.inventory
  for select to anon, authenticated using (true);
create policy inventory_insert_own on public.inventory
  for insert to authenticated with check (seller_id = auth.uid());
create policy inventory_update_own on public.inventory
  for update to authenticated using (seller_id = auth.uid()) with check (seller_id = auth.uid());
create policy inventory_delete_own on public.inventory
  for delete to authenticated using (seller_id = auth.uid());

revoke insert, update, delete, truncate on public.inventory from anon;

-- GTCR trust fields: refused from the API client roles. Database functions run as their owner
-- and the service role is a different role, so both pass.
create or replace function public._inv_trust_guard() returns trigger
language plpgsql as $$
declare n jsonb; o jsonb;
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  n := to_jsonb(new);
  if tg_op = 'INSERT' then
    if n->>'trust_flag' is not null or n->>'trust_clear_at' is not null or n->>'trust_recheck_at' is not null then
      raise exception 'trust_fields_locked' using hint = 'GTCR trust fields are set by the Trust Check only.';
    end if;
    return new;
  end if;
  o := to_jsonb(old);
  if (n->>'trust_flag') is distinct from (o->>'trust_flag')
     or ((n->>'trust_clear_at') is distinct from (o->>'trust_clear_at') and n->>'trust_clear_at' is not null)
     or ((n->>'trust_recheck_at') is distinct from (o->>'trust_recheck_at') and n->>'trust_recheck_at' is not null) then
    raise exception 'trust_fields_locked' using hint = 'GTCR trust fields are set by the Trust Check only.';
  end if;
  return new;
end $$;

drop trigger if exists inv_trust_guard on public.inventory;
create trigger inv_trust_guard before insert or update on public.inventory
  for each row execute function public._inv_trust_guard();

commit;

-- Check (run after): expect exactly the four policies above.
--   select policyname, cmd, roles from pg_policies where schemaname = 'public' and tablename = 'inventory';
