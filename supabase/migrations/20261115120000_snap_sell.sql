-- Snap & Sell, Phase 1 (capture now, resolve later). See CLAUDE.md "Snap & Sell".
--
-- Decisions (Stephen, 2026-11-14):
--   * Header + items, the light version. show_floor_transactions (the ledger)
--     is not rewritten: every existing row is already a one-card checkout. A
--     Snap & Sell sale adds ONE ledger row (source 'snap', card columns empty,
--     api_eligible = false so it never reaches v_comp_sales).
--   * The ledger can't be updated (restrictive RLS), so a snap sale's changing
--     state (needs_review → complete / unresolved_lot) lives in snap_sales.
--   * transaction_items holds card detail per checkout. Existing ledger rows are
--     backfilled one item each, and a trigger adds the item for every new
--     non-snap ledger row, so items stay complete going forward.
--   * The key that ties a checkout together is sale_key: the phone-made
--     client_sale_id when there is one, else the ledger row's own id.
--
-- Requires 20261023120000_show_mode_sales.sql (client_sale_id, voids_transaction_id);
-- the columns are added here too if it hasn't run. Re-runnable.

begin;

-- ── 1. Ledger: allow source 'snap' ──────────────────────────────────────────
alter table public.show_floor_transactions
  add column if not exists source               text not null default 'platform',
  add column if not exists client_sale_id       uuid,
  add column if not exists voids_transaction_id uuid;

create unique index if not exists show_floor_transactions_client_sale_id_key
  on public.show_floor_transactions (client_sale_id) where client_sale_id is not null;

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.show_floor_transactions'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ~* '\msource\M'
  loop
    execute format('alter table public.show_floor_transactions drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.show_floor_transactions
  add constraint show_floor_transactions_source_check
  check (source in ('platform', 'manual', 'community_report', 'social_extract', 'snap'));

-- ── 2. snap_sales: one row per Snap & Sell capture (owner-only, mutable) ────
create table if not exists public.snap_sales (
  client_sale_id  uuid primary key,                         -- made on the phone; also the ledger's client_sale_id
  owner_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  show_id         text references public.shows(id) on delete set null,
  transaction_id  uuid references public.show_floor_transactions(id) on delete set null,
  amount          numeric(12,2) not null check (amount > 0),  -- the source of truth for GMV
  payment_method  text,
  is_lot          boolean not null default false,
  item_count_hint integer check (item_count_hint is null or item_count_hint between 1 and 999),
  note            text,
  capture_status  text not null default 'needs_review'
                    check (capture_status in ('complete', 'needs_review', 'unresolved_lot')),
  captured_at     timestamptz not null,                     -- phone time at the moment of sale
  voided_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists snap_sales_owner_idx on public.snap_sales (owner_id, captured_at desc);
create index if not exists snap_sales_show_idx  on public.snap_sales (show_id);

alter table public.snap_sales enable row level security;
drop policy if exists "snap_sales_owner_all" on public.snap_sales;
create policy "snap_sales_owner_all" on public.snap_sales
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.snap_sales from anon;

-- ── 3. transaction_items: card detail per checkout (owner-only) ─────────────
create table if not exists public.transaction_items (
  id                    uuid primary key default gen_random_uuid(),
  sale_key              uuid not null,
  transaction_id        uuid references public.show_floor_transactions(id) on delete cascade,
  owner_id              uuid not null default auth.uid() references auth.users(id) on delete cascade,
  inventory_id          uuid references public.inventory(id) on delete set null,
  card_title            text,
  card_ref              jsonb,
  price                 numeric(12,2),
  -- Only 'observed' prices may feed comps or the data layer. 'allocated' is a
  -- split of a lot total and is for the dealer's own views only.
  price_basis           text not null default 'allocated' check (price_basis in ('observed', 'allocated')),
  identification_status text not null default 'unidentified'
                          check (identification_status in ('unidentified', 'suggested', 'confirmed', 'manual')),
  ai_confidence         numeric(4,3),
  ai_bbox               jsonb,
  source_photo_id       uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists transaction_items_sale_key_idx  on public.transaction_items (sale_key);
create index if not exists transaction_items_tx_idx        on public.transaction_items (transaction_id);
create index if not exists transaction_items_inventory_idx on public.transaction_items (inventory_id);
create index if not exists transaction_items_owner_idx     on public.transaction_items (owner_id);

alter table public.transaction_items enable row level security;
drop policy if exists "transaction_items_owner_all" on public.transaction_items;
create policy "transaction_items_owner_all" on public.transaction_items
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.transaction_items from anon;

-- ── 4. transaction_photos (metadata; files in the private sale-photos bucket) ─
create table if not exists public.transaction_photos (
  id             uuid primary key,
  sale_key       uuid not null references public.snap_sales(client_sale_id) on delete cascade,
  owner_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind           text not null check (kind in ('items', 'payment')),
  storage_path   text not null,
  created_at     timestamptz not null default now()
);
create index if not exists transaction_photos_sale_idx on public.transaction_photos (sale_key);

alter table public.transaction_photos enable row level security;
drop policy if exists "transaction_photos_owner_all" on public.transaction_photos;
create policy "transaction_photos_owner_all" on public.transaction_photos
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.transaction_photos from anon;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sale-photos', 'sale-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "sale_photos_obj_select_own" on storage.objects;
create policy "sale_photos_obj_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'sale-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "sale_photos_obj_insert_own" on storage.objects;
create policy "sale_photos_obj_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'sale-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "sale_photos_obj_delete_own" on storage.objects;
create policy "sale_photos_obj_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'sale-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── 5. Items for ledger rows ────────────────────────────────────────────────
-- The ledger was made in the dashboard, so its columns are read through
-- to_jsonb(): a column that doesn't exist reads as null instead of failing.
create or replace function public._sft_item_values(j jsonb)
returns table (sale_key uuid, owner_id uuid, inventory_id uuid, card_title text, card_ref jsonb, price numeric)
language sql stable set search_path = public as $$
  select coalesce((j->>'client_sale_id')::uuid, (j->>'id')::uuid),
         (j->>'seller_id')::uuid,
         (select i.id from public.inventory i where i.id = (j->>'inventory_id')::uuid),
         nullif(j->>'card_title', ''),
         nullif(jsonb_strip_nulls(jsonb_build_object(
           'player', j->>'player', 'year', j->>'year', 'card_set', j->>'card_set',
           'card_number', j->>'card_number', 'parallel', j->>'parallel', 'grader', j->>'grader',
           'grade', j->>'grade', 'cert_number', j->>'cert_number', 'category', j->>'category',
           'subcategory', j->>'subcategory', 'item_type', j->>'item_type')), '{}'::jsonb),
         (j->>'sold_price')::numeric;
$$;

create or replace function public.sft_items_from_ledger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  j jsonb := to_jsonb(new);
  v record;
begin
  begin
    if coalesce(j->>'source', 'platform') = 'snap' then return new; end if;
    if (j->>'voids_transaction_id') is not null then
      -- An undo: the original sale's item goes too.
      delete from public.transaction_items where transaction_id = (j->>'voids_transaction_id')::uuid;
      return new;
    end if;
    if coalesce((j->>'sold_price')::numeric, 0) < 0 then return new; end if;
    select * into v from public._sft_item_values(j);
    if v.owner_id is null or not exists (select 1 from auth.users u where u.id = v.owner_id) then return new; end if;
    insert into public.transaction_items
      (sale_key, transaction_id, owner_id, inventory_id, card_title, card_ref, price, price_basis, identification_status)
    values (v.sale_key, new.id, v.owner_id, v.inventory_id, v.card_title, v.card_ref, v.price, 'observed', 'confirmed');
  exception when others then
    -- Never let item bookkeeping block a sale.
    raise warning 'transaction_items not written for ledger row %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.sft_items_from_ledger() from public, anon, authenticated;

drop trigger if exists sft_items_from_ledger on public.show_floor_transactions;
create trigger sft_items_from_ledger
  after insert on public.show_floor_transactions
  for each row execute function public.sft_items_from_ledger();

-- Backfill: one confirmed, observed item per existing (non-voided) ledger row.
insert into public.transaction_items
  (sale_key, transaction_id, owner_id, inventory_id, card_title, card_ref, price, price_basis, identification_status)
select v.sale_key, t.id, v.owner_id, v.inventory_id, v.card_title, v.card_ref, v.price, 'observed', 'confirmed'
  from public.show_floor_transactions t
  cross join lateral (select to_jsonb(t) as j) x
  cross join lateral public._sft_item_values(x.j) v
 where coalesce(x.j->>'source', 'platform') <> 'snap'
   and (x.j->>'voids_transaction_id') is null
   and coalesce(v.price, 0) >= 0
   and v.owner_id is not null
   and exists (select 1 from auth.users u where u.id = v.owner_id)
   and not exists (select 1 from public.show_floor_transactions r where r.voids_transaction_id = t.id)
   and not exists (select 1 from public.transaction_items ti where ti.transaction_id = t.id);

-- ── 6. Undo a snap sale (10 minutes, like void_sale) ────────────────────────
create or replace function public.void_snap_sale(p_client_sale_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_sale public.snap_sales;
  v_cols text;
begin
  if auth.uid() is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  select * into v_sale from public.snap_sales
   where client_sale_id = p_client_sale_id and owner_id = auth.uid() for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if v_sale.voided_at is not null then return jsonb_build_object('voided', true, 'already', true); end if;
  if v_sale.capture_status <> 'needs_review' then return jsonb_build_object('error', 'resolved'); end if;
  if now() - v_sale.created_at > interval '10 minutes' then return jsonb_build_object('error', 'undo_window_expired'); end if;

  update public.snap_sales set voided_at = now(), updated_at = now() where client_sale_id = p_client_sale_id;
  delete from public.transaction_items where sale_key = p_client_sale_id and owner_id = auth.uid();

  if v_sale.transaction_id is not null
     and not exists (select 1 from public.show_floor_transactions where voids_transaction_id = v_sale.transaction_id) then
    select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
      into v_cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'show_floor_transactions'
       and c.is_generated = 'NEVER' and c.is_identity = 'NO'
       and c.column_name not in ('id', 'created_at', 'sold_at', 'sold_price', 'client_sale_id', 'voids_transaction_id');
    execute format(
      'insert into public.show_floor_transactions (%1$s, sold_at, sold_price, voids_transaction_id)
       select %1$s, now(), -sold_price, id from public.show_floor_transactions where id = $1', v_cols)
      using v_sale.transaction_id;
  end if;
  return jsonb_build_object('voided', true);
end;
$$;
revoke all on function public.void_snap_sale(uuid) from public, anon;
grant execute on function public.void_snap_sale(uuid) to authenticated;

-- ── 7. Item counts for organizer analytics (counts only, never prices) ──────
-- A snap sale counts as its resolved items, else the dealer's "N cards", else 1.
create or replace function public.show_sale_item_counts(p_show_id text)
returns table (client_sale_id uuid, items integer)
language sql stable security definer set search_path = public as $$
  select s.client_sale_id,
         coalesce(nullif((select count(*)::int from public.transaction_items ti where ti.sale_key = s.client_sale_id), 0),
                  s.item_count_hint, 1)
    from public.snap_sales s
   where s.show_id = p_show_id and s.voided_at is null;
$$;
revoke all on function public.show_sale_item_counts(text) from public, anon;
grant execute on function public.show_sale_item_counts(text) to authenticated;

commit;

-- ── Checks (run after) ──────────────────────────────────────────────────────
-- Per show, the backfilled items add up to the ledger (non-snap, net of undos).
-- Every row should show a difference of 0:
--   select t.show_id,
--          sum(t.sold_price) filter (where t.source <> 'snap') as ledger_gmv,
--          (select coalesce(sum(ti.price), 0) from transaction_items ti
--             join show_floor_transactions t2 on t2.id = ti.transaction_id
--            where t2.show_id = t.show_id) as items_gmv
--     from show_floor_transactions t group by t.show_id;
-- (A ledger row with no seller_id gets no item, so it shows up as a difference.)
