-- sellers security: a seller writes only their own row, and nobody else can read emails. Re-runnable.
-- See CLAUDE.md "sellers security". Deploy the app change that ships with this file FIRST (sign-up no
-- longer writes the row before the seller is signed in; the first sign-in does), then run this.
--
-- Before: the dashboard-made policies let anyone (anon included) create seller rows, edit anyone's
-- profile (display name, WhatsApp, Instagram, the handle buyers see) or delete sellers, and read
-- every seller's email address. After:
-- * Read: everyone, every column except email (show.html, seller-browse.html, the buyer view and
--   organizer screens read handles, names and contact links).
-- * Insert: a signed-in user, only their own row (id = auth.uid()).
-- * Update: a seller, only their own row; the handle can't be changed from the app.
-- * Delete: nobody from the app. The service role (Netlify functions) and SECURITY DEFINER
--   functions bypass all of this.
-- NOTE: a column added to sellers later is NOT readable by the app until granted:
--   grant select (new_column) on public.sellers to anon, authenticated;
--
-- To see the policies this replaces, run before applying:
--   select policyname, cmd, roles, qual, with_check from pg_policies
--    where schemaname = 'public' and tablename = 'sellers';

begin;

alter table public.sellers enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'sellers' loop
    execute format('drop policy %I on public.sellers', p.policyname);
  end loop;
end $$;

create policy sellers_read_all on public.sellers
  for select to anon, authenticated using (true);
create policy sellers_insert_own on public.sellers
  for insert to authenticated with check (id = auth.uid());
create policy sellers_update_own on public.sellers
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

revoke insert, update, delete, truncate on public.sellers from anon;
revoke delete, truncate on public.sellers from authenticated;

-- Email is readable only by the service role. Every other column stays readable.
revoke select on public.sellers from anon, authenticated;
do $$
declare v_cols text;
begin
  select string_agg(format('%I', column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'sellers' and column_name <> 'email';
  execute format('grant select (%s) on public.sellers to anon, authenticated', v_cols);
end $$;

-- The handle is what buyers see and how storefront links find a seller; the app never changes it.
create or replace function public._sellers_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') and new.handle is distinct from old.handle then
    raise exception 'handle_locked' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists sellers_guard on public.sellers;
create trigger sellers_guard before update on public.sellers
  for each row execute function public._sellers_guard();

commit;

-- Check (run after): expect sellers_insert_own (INSERT), sellers_read_all (SELECT), sellers_update_own (UPDATE).
--   select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'sellers';
