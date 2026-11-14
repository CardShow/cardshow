-- Cost Tracking & Stock Codes — Phase 1 (see CLAUDE.md "Cost Tracking & Stock Codes").
--
-- * inventory.stock_code      dealer's short label (S-12, R-40, B-3, L-1 or custom).
--                             Not secret: inventory is readable by anyone today.
-- * stock_code_counters       next number per seller per prefix (owner-only).
-- * next_stock_code()         atomic next code for one prefix.
-- * assign_stock_codes()      gives codes to the caller's cards that have none,
--                             in the order of the ids passed.
-- * set_stock_code()          sets/clears one card's code; refuses a duplicate.
-- * inventory_costs           PRIVATE: what the dealer paid. Owner-only RLS.
-- * transaction_costs         PRIVATE: the cost copied at the moment of a sale,
--                             keyed by client_sale_id (the same id the sale's
--                             show_floor_transactions row carries, when it has one).
--
-- Cost never goes on inventory, show_inventory or show_floor_transactions:
-- those are read by buyers / organizers. Re-runnable.

-- ── Stock code on inventory ──────────────────────────────────────────────────
alter table public.inventory add column if not exists stock_code text;
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'inventory' and column_name = 'stock_code_key') then
    alter table public.inventory add column stock_code_key text
      generated always as (upper(regexp_replace(coalesce(stock_code, ''), '[^A-Za-z0-9]', '', 'g'))) stored;
  end if;
end $$;
create unique index if not exists inventory_owner_stock_code_key_uq
  on public.inventory (seller_id, stock_code_key)
  where stock_code is not null and stock_code <> '';

-- ── Counters ─────────────────────────────────────────────────────────────────
create table if not exists public.stock_code_counters (
  owner_id   uuid not null references auth.users(id) on delete cascade,
  prefix     text not null,
  next_value integer not null default 1,
  primary key (owner_id, prefix)
);
alter table public.stock_code_counters enable row level security;
drop policy if exists "stock_code_counters_owner_all" on public.stock_code_counters;
create policy "stock_code_counters_owner_all" on public.stock_code_counters
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.stock_code_counters from anon;

-- Prefix for a card: S = graded (numeric grade), B = sealed, L = lot, R = everything else.
create or replace function public.stock_code_prefix(p_item_type text, p_grade text)
returns text language sql immutable as $$
  select case
    when p_item_type = 'sealed' then 'B'
    when p_item_type = 'lot'    then 'L'
    when coalesce(p_grade, '') ~ '^[0-9]+(\.[0-9]+)?$' then 'S'
    else 'R'
  end
$$;

create or replace function public.next_stock_code(p_prefix text)
returns text language plpgsql security invoker as $$
declare v integer;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.stock_code_counters (owner_id, prefix, next_value)
  values (auth.uid(), upper(p_prefix), 2)
  on conflict (owner_id, prefix)
    do update set next_value = public.stock_code_counters.next_value + 1
  returning next_value - 1 into v;
  return upper(p_prefix) || '-' || v;
end $$;

-- Gives the next free code (skipping any a dealer typed by hand, e.g. S-50) to
-- each of the caller's cards in p_ids that has no code yet. Returns
-- [{id, stock_code}] for the cards it coded.
create or replace function public.assign_stock_codes(p_ids uuid[])
returns jsonb language plpgsql security invoker as $$
declare
  v_uid  uuid := auth.uid();
  v_out  jsonb := '[]'::jsonb;
  v_card record;
  v_code text;
  v_tries int;
  v_rows  int;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  for v_card in
    select i.id, i.item_type, i.grade::text as grade, t.ord
      from unnest(p_ids) with ordinality as t(id, ord)
      join public.inventory i on i.id = t.id
     where i.seller_id = v_uid and coalesce(i.stock_code, '') = ''
     order by t.ord
  loop
    v_tries := 0;
    loop
      v_tries := v_tries + 1;
      v_code := public.next_stock_code(public.stock_code_prefix(v_card.item_type, v_card.grade));
      begin
        update public.inventory set stock_code = v_code
         where id = v_card.id and seller_id = v_uid and coalesce(stock_code, '') = '';
        get diagnostics v_rows = row_count;
        if v_rows = 0 then v_code := null; end if;   -- coded meanwhile by another call
        exit;
      exception when unique_violation then
        if v_tries > 500 then v_code := null; exit; end if;   -- give up on this card
      end;
    end loop;
    if v_code is not null then
      v_out := v_out || jsonb_build_object('id', v_card.id, 'stock_code', v_code);
    end if;
  end loop;
  return v_out;
end $$;

-- Sets one card's code ('' / null clears it). {ok, stock_code} or
-- {error:'duplicate', card_id, card_title} / {error:'not_found'}.
create or replace function public.set_stock_code(p_id uuid, p_code text)
returns jsonb language plpgsql security invoker as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
  v_key  text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_dup  record;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  if v_code is not null and v_key = '' then return jsonb_build_object('error', 'invalid'); end if;
  if v_code is not null and length(v_code) > 24 then return jsonb_build_object('error', 'too_long'); end if;
  if not exists (select 1 from public.inventory where id = p_id and seller_id = v_uid) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_code is not null then
    select id, card_title into v_dup from public.inventory
     where seller_id = v_uid and stock_code_key = v_key and id <> p_id and coalesce(stock_code, '') <> ''
     limit 1;
    if found then
      return jsonb_build_object('error', 'duplicate', 'card_id', v_dup.id, 'card_title', v_dup.card_title);
    end if;
  end if;
  begin
    update public.inventory set stock_code = v_code where id = p_id and seller_id = v_uid;
  exception when unique_violation then
    return jsonb_build_object('error', 'duplicate');
  end;
  return jsonb_build_object('ok', true, 'stock_code', v_code);
end $$;

revoke all on function public.next_stock_code(text)       from public, anon;
revoke all on function public.assign_stock_codes(uuid[])  from public, anon;
revoke all on function public.set_stock_code(uuid, text)  from public, anon;
grant execute on function public.next_stock_code(text)      to authenticated;
grant execute on function public.assign_stock_codes(uuid[]) to authenticated;
grant execute on function public.set_stock_code(uuid, text) to authenticated;

-- ── Private cost per item ────────────────────────────────────────────────────
create table if not exists public.inventory_costs (
  inventory_id  uuid primary key references public.inventory(id) on delete cascade,
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  cost_basis    numeric(12,2) check (cost_basis is null or cost_basis >= 0),
  acquired_at   date,
  acquired_from text,
  lot_id        uuid,                       -- Phase 2 (lot cost split)
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists inventory_costs_owner_idx on public.inventory_costs (owner_id);
alter table public.inventory_costs enable row level security;
drop policy if exists "inventory_costs_owner_all" on public.inventory_costs;
create policy "inventory_costs_owner_all" on public.inventory_costs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.inventory_costs from anon;

-- ── Private cost copied at sale time ─────────────────────────────────────────
-- Keyed by the sale's client_sale_id (generated on the phone), so a queued
-- write can retry without duplicating, an offline sale doesn't need the
-- server's ledger id, and an off-show sale (no ledger row) still has a profit.
create table if not exists public.transaction_costs (
  client_sale_id uuid primary key,
  owner_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  inventory_id   uuid references public.inventory(id) on delete set null,
  show_id        text,                      -- no FK: shows.id can be deleted/merged; ledger is the record
  sale_price     numeric(12,2),
  cost_at_sale   numeric(12,2) check (cost_at_sale is null or cost_at_sale >= 0),
  sold_at        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists transaction_costs_owner_idx on public.transaction_costs (owner_id, sold_at);
alter table public.transaction_costs enable row level security;
drop policy if exists "transaction_costs_owner_all" on public.transaction_costs;
create policy "transaction_costs_owner_all" on public.transaction_costs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.transaction_costs from anon;

-- updated_at on edit
create or replace function public.cost_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists inventory_costs_touch on public.inventory_costs;
create trigger inventory_costs_touch before update on public.inventory_costs
  for each row execute function public.cost_touch_updated_at();
drop trigger if exists transaction_costs_touch on public.transaction_costs;
create trigger transaction_costs_touch before update on public.transaction_costs
  for each row execute function public.cost_touch_updated_at();
