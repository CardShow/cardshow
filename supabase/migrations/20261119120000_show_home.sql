-- Trades + Show Home, Phase 2 (Show Home screen, show list, inventory snapshots).
-- See CLAUDE.md "Trades + Show Home". Run after 20261118120000_trades_show_home.sql. Re-runnable.
--
-- * dealer_show_report(): same as Phase 1, plus 'unbalanced' [{txn_id, delta}] and
--   'ungrouped_txn_ids', so each data-quality warning can link to its fix.
-- * dealer_show_list(): the caller's shows (CardShow shows they're in or sold at, and
--   their private shows) with cards out and net P/L for each.
-- * take_inventory_snapshot(): snapshot of the caller's Available inventory.
-- * close_ended_show_snapshots(): service-role job (hourly, close-show-snapshots.js)
--   that writes the show_end snapshot for a show whose last day is over.

begin;

-- ── 1. The Show report, plus the lists the data-quality strip links to ──────
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
    -- Phase 2: what the data-quality strip links to.
    'unbalanced', coalesce((select jsonb_agg(jsonb_build_object('txn_id', k, 'delta', delta) order by k) from bal where delta <> 0), '[]'::jsonb),
    'ungrouped_txn_ids', coalesce((select jsonb_agg(distinct txn_id) from outs where ungrouped), '[]'::jsonb),
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

-- ── 2. The dealer's shows, with P/L per show ───────────────────────────────
create or replace function public.dealer_show_list()
returns jsonb language sql stable security invoker set search_path = public as $$
  with me as (select auth.uid() as u),
  co as (
    select 's:' || t.show_id as sk, coalesce(t.client_sale_id, t.id) as k, t.show_id
      from public.show_floor_transactions t, me
     where t.seller_id = me.u and t.show_id is not null
       and t.voids_transaction_id is null and coalesce(t.sold_price, 0) > 0
       and not exists (select 1 from public.show_floor_transactions x where x.voids_transaction_id = t.id)
    union all
    select case when d.show_id is not null then 's:' || d.show_id else 'd:' || d.dealer_show_id::text end, d.id, d.show_id
      from public.dealer_transactions d, me
     where d.owner_id = me.u and (d.show_id is not null or d.dealer_show_id is not null)
  ),
  outs as (
    select co.sk, coalesce(i.price, 0) - coalesce(c.cost_at_sale, 0) as profit, c.cost_at_sale is null as nocost
      from co
      join public.transaction_items i on i.sale_key = co.k and i.direction = 'out' and i.owner_id = (select u from me)
      left join public.transaction_item_costs c on c.transaction_item_id = i.id
  ),
  agg as (
    select sk, count(*) as cards_out, sum(profit) as net_pl, count(*) filter (where nocost) as missing_cost
      from outs group by sk
  ),
  shows_all as (
    select 's:' || s.id as sk, s.id as show_id, null::uuid as dealer_show_id, s.name,
           s.start_date, s.end_date, s.date as date_text, 'cardshow' as kind
      from public.shows s
     where s.id in (select ss.show_id from public.show_sellers ss where ss.seller_id = (select u from me))
        or s.id in (select show_id from co where show_id is not null)
    union all
    select 'd:' || ds.id::text, null, ds.id, ds.name, ds.show_date, ds.end_date, null, 'private'
      from public.dealer_shows ds where ds.owner_id = (select u from me)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'show_id', sa.show_id, 'dealer_show_id', sa.dealer_show_id, 'name', sa.name,
           'start_date', sa.start_date, 'end_date', sa.end_date, 'date_text', sa.date_text, 'kind', sa.kind,
           'cards_out', coalesce(a.cards_out, 0), 'net_pl', coalesce(a.net_pl, 0), 'missing_cost', coalesce(a.missing_cost, 0))
         order by sa.start_date desc nulls last, sa.name), '[]'::jsonb)
    from shows_all sa left join agg a using (sk);
$$;
revoke all on function public.dealer_show_list() from public, anon;
grant execute on function public.dealer_show_list() to authenticated;

-- ── 3. Inventory snapshots ─────────────────────────────────────────────────
-- Available cards only; a missing cost or price counts as 0 (and is counted).
-- Only ever called with the owner fixed by the two functions below.
create or replace function public._snapshot_for(p_owner uuid, p_kind text, p_show_id text, p_dealer_show_id uuid, p_client uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.inventory_snapshots;
begin
  insert into public.inventory_snapshots
    (client_snapshot_id, owner_id, show_id, dealer_show_id, kind, card_count, cost_total, ask_total, cards_missing_cost, cards_missing_price)
  select p_client, p_owner, p_show_id, p_dealer_show_id, p_kind,
         count(*), coalesce(sum(ic.cost_basis), 0), coalesce(sum(i.price), 0),
         count(*) filter (where ic.cost_basis is null), count(*) filter (where coalesce(i.price, 0) = 0)
    from public.inventory i
    left join public.inventory_costs ic on ic.inventory_id = i.id
   where i.seller_id = p_owner and i.status = 'Available'
  on conflict do nothing
  returning * into v_row;
  if v_row.id is null then            -- already taken: hand back the existing one
    select * into v_row from public.inventory_snapshots s
     where s.owner_id = p_owner
       and ((p_client is not null and s.client_snapshot_id = p_client)
         or (p_kind in ('show_start', 'show_end') and s.kind = p_kind
             and coalesce(s.show_id, s.dealer_show_id::text) = coalesce(p_show_id, p_dealer_show_id::text)))
     order by s.taken_at desc limit 1;
    return to_jsonb(v_row) || jsonb_build_object('already', true);
  end if;
  return to_jsonb(v_row);
end;
$$;
revoke all on function public._snapshot_for(uuid, text, text, uuid, uuid) from public, anon, authenticated;

create or replace function public.take_inventory_snapshot(p_kind text, p_show_id text default null,
                                                          p_dealer_show_id uuid default null, p_client_snapshot_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  if p_kind not in ('show_start', 'show_end', 'baseline', 'manual') then return jsonb_build_object('error', 'bad_kind'); end if;
  if p_dealer_show_id is not null and not exists (select 1 from public.dealer_shows where id = p_dealer_show_id and owner_id = auth.uid()) then
    return jsonb_build_object('error', 'not_found');
  end if;
  return public._snapshot_for(auth.uid(), p_kind, p_show_id, p_dealer_show_id, p_client_snapshot_id);
end;
$$;
revoke all on function public.take_inventory_snapshot(text, text, uuid, uuid) from public, anon;
grant execute on function public.take_inventory_snapshot(text, text, uuid, uuid) to authenticated;

-- Hourly: a show that has a show_start but no show_end gets one once its last day
-- is over in the show's time zone (America/Los_Angeles when none is set).
create or replace function public.close_ended_show_snapshots()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; v_last date; v_tz text; n int := 0;
begin
  for r in
    select s.owner_id, s.show_id, s.dealer_show_id
      from public.inventory_snapshots s
     where s.kind = 'show_start'
       and not exists (select 1 from public.inventory_snapshots e
                        where e.owner_id = s.owner_id and e.kind = 'show_end'
                          and coalesce(e.show_id, e.dealer_show_id::text) = coalesce(s.show_id, s.dealer_show_id::text))
  loop
    v_last := null; v_tz := 'America/Los_Angeles';
    if r.show_id is not null then
      select coalesce(sh.end_date, sh.start_date), coalesce(nullif(to_jsonb(sh)->>'timezone', ''), 'America/Los_Angeles')
        into v_last, v_tz from public.shows sh where sh.id = r.show_id;
    else
      select coalesce(ds.end_date, ds.show_date) into v_last from public.dealer_shows ds where ds.id = r.dealer_show_id;
    end if;
    if v_last is not null and (now() at time zone v_tz)::date > v_last then
      perform public._snapshot_for(r.owner_id, 'show_end', r.show_id, r.dealer_show_id, null);
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke all on function public.close_ended_show_snapshots() from public, anon, authenticated;
grant execute on function public.close_ended_show_snapshots() to service_role;

commit;
