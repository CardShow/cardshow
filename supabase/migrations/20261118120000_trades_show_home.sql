-- Trades + Show Home, Phase 1 (data model + metrics engine). See CLAUDE.md "Trades + Show Home".
--
-- Decisions (Stephen, 2026-11-18):
--   * Trades and buys live in an owner-only, editable table (dealer_transactions),
--     NOT on show_floor_transactions. The ledger is readable by every signed-in
--     user and can't be edited, so trade values and cash there would reach
--     organizers and couldn't be undone. Organizers get a trade COUNT only
--     (show_trade_counts()).
--   * Organizer GMV is untouched: the ledger still holds only cash sales at
--     CardShow shows. Sales at a dealer's private show, and imported sales at a
--     private show, also go in dealer_transactions.
--   * transaction_item_costs (per-card cost at sale/trade time) is built here.
--
-- Requires (in order): 20261023120000_show_mode_sales.sql,
-- 20261114120000_cost_tracking.sql, 20261115120000_snap_sell.sql. Re-runnable.

begin;

-- ── 1. Ledger: transaction type + 'import' source ───────────────────────────
alter table public.show_floor_transactions
  add column if not exists txn_type text not null default 'sale';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'show_floor_transactions_txn_type_check') then
    alter table public.show_floor_transactions
      add constraint show_floor_transactions_txn_type_check check (txn_type in ('sale', 'lot_sale'));
  end if;
end $$;
-- Snap & Sell lots that already exist. (Runs as the table owner; ledger RLS
-- blocks updates from the app, not migrations.)
update public.show_floor_transactions set txn_type = 'lot_sale'
 where txn_type = 'sale' and source = 'snap' and coalesce(to_jsonb(show_floor_transactions)->>'item_type', '') = 'lot';

alter table public.show_floor_transactions drop constraint if exists show_floor_transactions_source_check;
alter table public.show_floor_transactions
  add constraint show_floor_transactions_source_check
  check (source in ('platform', 'manual', 'community_report', 'social_extract', 'snap', 'import'));

-- ── 2. Dealer-private shows (shows not run on CardShow) ─────────────────────
create table if not exists public.dealer_shows (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  show_date  date not null,
  end_date   date,
  venue      text,
  created_at timestamptz not null default now()
);
create index if not exists dealer_shows_owner_idx on public.dealer_shows (owner_id, show_date desc);
alter table public.dealer_shows enable row level security;
drop policy if exists "dealer_shows_owner_all" on public.dealer_shows;
create policy "dealer_shows_owner_all" on public.dealer_shows for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.dealer_shows from anon;

-- ── 3. Trades, buys, and private-show sales (owner-only, editable) ──────────
create table if not exists public.dealer_transactions (
  id                uuid primary key default gen_random_uuid(),
  client_capture_id uuid unique,                        -- made on the phone; retries upsert on it
  owner_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  show_id           text references public.shows(id) on delete set null,
  dealer_show_id    uuid references public.dealer_shows(id) on delete cascade,
  txn_type          text not null check (txn_type in ('sale', 'lot_sale', 'trade', 'buy')),
  occurred_at       timestamptz not null default now(),
  cash_in           numeric(12,2) not null default 0 check (cash_in  >= 0),   -- cash the dealer received
  cash_out          numeric(12,2) not null default 0 check (cash_out >= 0),   -- cash the dealer paid
  payment_method    text,
  is_ungrouped      boolean not null default false,     -- import bucket: cards traded, counterpart unknown
  source            text not null default 'app' check (source in ('app', 'import')),
  import_key        text,                               -- Phase 3 dedup (hash of date + time + cards out)
  note              text,
  review_note       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (show_id is null or dealer_show_id is null)
);
create index if not exists dealer_transactions_owner_idx on public.dealer_transactions (owner_id, occurred_at desc);
create index if not exists dealer_transactions_show_idx on public.dealer_transactions (show_id);
create index if not exists dealer_transactions_dshow_idx on public.dealer_transactions (dealer_show_id);
create unique index if not exists dealer_transactions_import_key on public.dealer_transactions (owner_id, import_key)
  where import_key is not null;
alter table public.dealer_transactions enable row level security;
drop policy if exists "dealer_transactions_owner_all" on public.dealer_transactions;
create policy "dealer_transactions_owner_all" on public.dealer_transactions for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.dealer_transactions from anon;

-- ── 4. Items: direction, agreed values, link to a dealer transaction ────────
alter table public.transaction_items
  add column if not exists direction text not null default 'out',
  add column if not exists dealer_txn_id uuid references public.dealer_transactions(id) on delete cascade;
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.transaction_items'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ~* 'price_basis|direction'
  loop
    execute format('alter table public.transaction_items drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.transaction_items
  add constraint transaction_items_price_basis_check
    check (price_basis in ('observed', 'allocated', 'agreed_trade_value', 'unknown')),
  add constraint transaction_items_direction_check check (direction in ('out', 'in'));
create index if not exists transaction_items_dealer_txn_idx on public.transaction_items (dealer_txn_id);

-- ── 5. Per-card cost at the moment a card left (owner-only) ─────────────────
create table if not exists public.transaction_item_costs (
  transaction_item_id uuid primary key references public.transaction_items(id) on delete cascade,
  owner_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  cost_at_sale        numeric(12,2) check (cost_at_sale is null or cost_at_sale >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
alter table public.transaction_item_costs enable row level security;
drop policy if exists "transaction_item_costs_owner_all" on public.transaction_item_costs;
create policy "transaction_item_costs_owner_all" on public.transaction_item_costs for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.transaction_item_costs from anon;

-- Where a card came from (a trade or buy); "What came in" on Show Home.
alter table public.inventory_costs
  add column if not exists acquired_txn_id uuid references public.dealer_transactions(id) on delete set null;

-- A one-card sale's cost (transaction_costs, one row per sale) becomes its item's
-- cost. Two triggers because the sale and its cost copy can arrive in either order.
create or replace function public._copy_sale_cost_to_item(p_sale_key uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_item uuid; v_owner uuid; v_cost numeric; v_n int;
begin
  select count(*) into v_n from public.transaction_items where sale_key = p_sale_key and direction = 'out';
  if v_n <> 1 then return; end if;                              -- lots are costed per card elsewhere
  select id, owner_id into v_item, v_owner from public.transaction_items where sale_key = p_sale_key and direction = 'out';
  select cost_at_sale into v_cost from public.transaction_costs where client_sale_id = p_sale_key;
  if not found then return; end if;
  insert into public.transaction_item_costs (transaction_item_id, owner_id, cost_at_sale)
  values (v_item, v_owner, v_cost)
  on conflict (transaction_item_id) do update set cost_at_sale = excluded.cost_at_sale, updated_at = now();
end;
$$;
revoke all on function public._copy_sale_cost_to_item(uuid) from public, anon, authenticated;

create or replace function public.transaction_costs_to_items()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public._copy_sale_cost_to_item(new.client_sale_id);
  exception when others then
    raise warning 'item cost not copied for sale %: %', new.client_sale_id, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.transaction_costs_to_items() from public, anon, authenticated;
drop trigger if exists transaction_costs_to_items on public.transaction_costs;
create trigger transaction_costs_to_items after insert or update of cost_at_sale on public.transaction_costs
  for each row execute function public.transaction_costs_to_items();

-- The ledger trigger from 20261115120000_snap_sell.sql, now also skipping lot
-- rows (their cards are added per card) and copying a cost that arrived first.
create or replace function public.sft_items_from_ledger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  j jsonb := to_jsonb(new);
  v record;
begin
  begin
    if coalesce(j->>'source', 'platform') = 'snap' or coalesce(j->>'txn_type', 'sale') = 'lot_sale' then return new; end if;
    if (j->>'voids_transaction_id') is not null then
      delete from public.transaction_items where transaction_id = (j->>'voids_transaction_id')::uuid;
      return new;
    end if;
    if coalesce((j->>'sold_price')::numeric, 0) < 0 then return new; end if;
    select * into v from public._sft_item_values(j);
    if v.owner_id is null or not exists (select 1 from auth.users u where u.id = v.owner_id) then return new; end if;
    insert into public.transaction_items
      (sale_key, transaction_id, owner_id, inventory_id, card_title, card_ref, price, price_basis, identification_status, direction)
    values (v.sale_key, new.id, v.owner_id, v.inventory_id, v.card_title, v.card_ref, v.price,
            case when coalesce((j->>'api_eligible')::boolean, true) then 'observed' else 'allocated' end, 'confirmed', 'out');
    perform public._copy_sale_cost_to_item(v.sale_key);
  exception when others then
    raise warning 'transaction_items not written for ledger row %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.sft_items_from_ledger() from public, anon, authenticated;

-- Backfill item costs for one-card sales that already have a cost copy.
insert into public.transaction_item_costs (transaction_item_id, owner_id, cost_at_sale)
select i.id, i.owner_id, tc.cost_at_sale
  from public.transaction_items i
  join public.transaction_costs tc on tc.client_sale_id = i.sale_key
 where i.direction = 'out'
   and (select count(*) from public.transaction_items x where x.sale_key = i.sale_key and x.direction = 'out') = 1
on conflict (transaction_item_id) do nothing;

-- ── 6. Inventory value snapshots ────────────────────────────────────────────
create table if not exists public.inventory_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  client_snapshot_id  uuid unique,                    -- retries upsert on it
  owner_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  show_id             text references public.shows(id) on delete set null,
  dealer_show_id      uuid references public.dealer_shows(id) on delete cascade,
  kind                text not null check (kind in ('show_start', 'show_end', 'baseline', 'manual')),
  taken_at            timestamptz not null default now(),
  card_count          integer not null,
  cost_total          numeric(12,2) not null,
  ask_total           numeric(12,2) not null,
  cards_missing_cost  integer not null,
  cards_missing_price integer not null
);
-- One show_start and one show_end per dealer per show.
create unique index if not exists inventory_snapshots_show_once
  on public.inventory_snapshots (owner_id, coalesce(show_id, dealer_show_id::text), kind)
  where kind in ('show_start', 'show_end');
alter table public.inventory_snapshots enable row level security;
drop policy if exists "inventory_snapshots_owner_all" on public.inventory_snapshots;
create policy "inventory_snapshots_owner_all" on public.inventory_snapshots for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.inventory_snapshots from anon;

-- ── 7. Organizers: trade count per show (a count, nothing else) ─────────────
create or replace function public.show_trade_count(p_show_id text)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.dealer_transactions where show_id = p_show_id and txn_type = 'trade';
$$;
revoke all on function public.show_trade_count(text) from public, anon;
grant execute on function public.show_trade_count(text) to authenticated;

-- ── 8. The Show report (every Show Home number comes from here) ─────────────
-- Security invoker: RLS limits it to the caller's own rows. Pass a CardShow
-- show id or a dealer show id. Full precision; round in display only.
create or replace function public.dealer_show_report(p_show_id text default null, p_dealer_show_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  r jsonb;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  if p_show_id is null and p_dealer_show_id is null then return jsonb_build_object('error', 'no_show'); end if;

  with co as (            -- every checkout at this show: ledger sales + dealer transactions
    select coalesce(t.client_sale_id, t.id) as k, t.txn_type as typ,
           t.sold_price::numeric as cash_in, 0::numeric as cash_out, false as ungrouped, t.id as txn_id,
           t.sold_at as at
      from public.show_floor_transactions t
     where p_show_id is not null and t.show_id = p_show_id and t.seller_id = v_uid
       and t.voids_transaction_id is null and coalesce(t.sold_price, 0) > 0
       and not exists (select 1 from public.show_floor_transactions x where x.voids_transaction_id = t.id)
    union all
    select d.id, d.txn_type, d.cash_in, d.cash_out, d.is_ungrouped, d.id, d.occurred_at
      from public.dealer_transactions d
     where d.owner_id = v_uid
       and ((p_show_id is not null and d.show_id = p_show_id)
         or (p_dealer_show_id is not null and d.dealer_show_id = p_dealer_show_id))
  ),
  items as (
    select i.*, co.typ, co.ungrouped, co.txn_id, co.at,
           c.cost_at_sale, coalesce(i.price, 0) as val
      from co
      join public.transaction_items i on i.sale_key = co.k and i.owner_id = v_uid
      left join public.transaction_item_costs c on c.transaction_item_id = i.id
  ),
  outs as (
    select o.*, coalesce(o.cost_at_sale, 0) as cost, o.val - coalesce(o.cost_at_sale, 0) as profit,
           case when o.typ = 'trade' then 'traded' when o.typ = 'lot_sale' then 'lot' else 'cash_sale' end as bucket,
           coalesce(inv.stock_code, o.card_ref->>'stock_code') as code
      from items o left join public.inventory inv on inv.id = o.inventory_id
     where o.direction = 'out'
  ),
  ins as (
    select n.*, coalesce(ic.cost_basis, n.val) as cost_in, coalesce(inv.price, 0)::numeric as ask,
           coalesce(inv.status, '') = 'Available' as on_hand
      from items n
      left join public.inventory inv on inv.id = n.inventory_id
      left join public.inventory_costs ic on ic.inventory_id = n.inventory_id
     where n.direction = 'in' and n.typ in ('trade', 'buy')
  ),
  bal as (               -- trades whose two sides plus cash don't match
    select co.k,
           coalesce((select sum(val) from items i where i.sale_key = co.k and i.direction = 'out'), 0) + co.cash_out
         - coalesce((select sum(val) from items i where i.sale_key = co.k and i.direction = 'in'), 0) - co.cash_in as delta
      from co where co.typ = 'trade' and not co.ungrouped
  ),
  s as (
    select
      (select count(*) from outs) as cards_out,
      (select coalesce(sum(profit), 0) from outs) as net_pl,
      (select coalesce(sum(cost), 0) from outs) as cost_out,
      (select coalesce(sum(val), 0) from outs) as value_out,
      (select count(*) from outs where profit > 0) as wins,
      (select count(*) from outs where profit < 0) as losses,
      (select count(*) from outs where profit = 0) as even,
      (select max(profit) from outs) as biggest_win,
      (select min(profit) from outs) as biggest_loss,
      (select count(*) from outs where bucket = 'traded') as trade_cards,
      (select coalesce(sum(cost), 0) from outs where bucket = 'traded') as trade_cost,
      (select coalesce(sum(val), 0) from outs where bucket = 'traded') as trade_value,
      (select count(*) from outs where bucket <> 'traded') as cash_cards,
      (select coalesce(sum(cost), 0) from outs where bucket <> 'traded') as cash_cost,
      (select coalesce(sum(val), 0) from outs where bucket <> 'traded') as cash_value,
      (select count(*) from ins) as in_cards,
      (select coalesce(sum(cost_in), 0) from ins) as in_cost,
      (select coalesce(sum(ask), 0) from ins) as in_ask,
      (select count(*) from ins where on_hand) as onhand_cards,
      (select coalesce(sum(cost_in), 0) from ins where on_hand) as onhand_cost,
      (select coalesce(sum(ask), 0) from ins where on_hand) as onhand_ask,
      (select coalesce(sum(cash_in), 0) from co) as cash_received,
      (select coalesce(sum(cash_out), 0) from co) as cash_paid,
      (select count(*) from outs where cost_at_sale is not null) as with_cost,
      (select count(*) from bal where delta <> 0) as unbalanced,
      (select count(*) from outs where ungrouped) as ungrouped_cards
  ),
  snaps as (
    select kind, jsonb_build_object('taken_at', taken_at, 'card_count', card_count, 'cost_total', cost_total,
             'ask_total', ask_total, 'cards_missing_cost', cards_missing_cost, 'cards_missing_price', cards_missing_price) as j,
           card_count, cost_total, ask_total
      from public.inventory_snapshots
     where owner_id = v_uid and kind in ('show_start', 'show_end')
       and ((p_show_id is not null and show_id = p_show_id) or (p_dealer_show_id is not null and dealer_show_id = p_dealer_show_id))
  )
  select jsonb_build_object(
    'cards_out', s.cards_out,
    'net_pl', s.net_pl,
    'margin_on_cost', case when s.cost_out > 0 then s.net_pl / s.cost_out end,
    'trade_value_gained', s.trade_value - s.trade_cost,
    'cash_sale_profit', s.cash_value - s.cash_cost,
    'wins', s.wins, 'losses', s.losses, 'even', s.even,
    'win_rate', case when s.cards_out > 0 then s.wins::numeric / s.cards_out end,
    'biggest_win', s.biggest_win, 'biggest_loss', s.biggest_loss,
    'trade_cards', s.trade_cards, 'trade_cost', s.trade_cost, 'trade_value', s.trade_value,
    'trade_gain', s.trade_value - s.trade_cost,
    'trade_gain_on_cost', case when s.trade_cost > 0 then (s.trade_value - s.trade_cost) / s.trade_cost end,
    'cash_cards', s.cash_cards, 'cash_cost', s.cash_cost, 'cash_value', s.cash_value,
    'cash_profit', s.cash_value - s.cash_cost,
    'cash_margin', case when s.cash_cost > 0 then (s.cash_value - s.cash_cost) / s.cash_cost end,
    'in_cards', s.in_cards, 'in_cost', s.in_cost, 'in_ask', s.in_ask, 'in_ask_gain', s.in_ask - s.in_cost,
    'in_ask_gain_pct', case when s.in_cost > 0 then (s.in_ask - s.in_cost) / s.in_cost end,
    'onhand_cards', s.onhand_cards, 'onhand_cost', s.onhand_cost, 'onhand_ask', s.onhand_ask,
    'onhand_ask_gain_pct', case when s.onhand_cost > 0 then (s.onhand_ask - s.onhand_cost) / s.onhand_cost end,
    'cash_received', s.cash_received, 'cash_paid', s.cash_paid, 'net_cash', s.cash_received - s.cash_paid,
    'cost_coverage', case when s.cards_out > 0 then s.with_cost::numeric / s.cards_out end,
    'cards_missing_cost', s.cards_out - s.with_cost,
    'unbalanced_trades', s.unbalanced,
    'ungrouped_cards', s.ungrouped_cards,
    'needs_review', (select count(*) from public.snap_sales ss
                      where ss.owner_id = v_uid and ss.capture_status = 'needs_review' and ss.voided_at is null
                        and p_show_id is not null and ss.show_id = p_show_id),
    'mix', jsonb_build_object(
      'traded',    jsonb_build_object('cards', (select count(*) from outs where bucket = 'traded'),    'value', (select coalesce(sum(val), 0) from outs where bucket = 'traded')),
      'cash_sale', jsonb_build_object('cards', (select count(*) from outs where bucket = 'cash_sale'), 'value', (select coalesce(sum(val), 0) from outs where bucket = 'cash_sale')),
      'lot',       jsonb_build_object('cards', (select count(*) from outs where bucket = 'lot'),       'value', (select coalesce(sum(val), 0) from outs where bucket = 'lot'))),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
              'code', code, 'title', card_title, 'cost', case when cost_at_sale is null then null else cost end,
              'value', val, 'profit', profit,
              'result', case when profit > 0 then 'Win' when profit < 0 then 'Loss' else 'Even' end,
              'type', typ, 'txn_id', txn_id, 'item_id', id, 'price_basis', price_basis, 'at', at)
            order by at, txn_id, code) from outs), '[]'::jsonb),
    'snapshot_start', (select j from snaps where kind = 'show_start'),
    'snapshot_end',   (select j from snaps where kind = 'show_end'),
    'growth_cards', (select e.card_count - b.card_count from snaps b, snaps e where b.kind = 'show_start' and e.kind = 'show_end'),
    'growth_cost',  (select e.cost_total - b.cost_total from snaps b, snaps e where b.kind = 'show_start' and e.kind = 'show_end'),
    'growth_ask',   (select e.ask_total  - b.ask_total  from snaps b, snaps e where b.kind = 'show_start' and e.kind = 'show_end')
  ) into r from s;
  return r;
end;
$$;
revoke all on function public.dealer_show_report(text, uuid) from public, anon;
grant execute on function public.dealer_show_report(text, uuid) to authenticated;

commit;
