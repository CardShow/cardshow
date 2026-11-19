-- Trades + Show Home, Phase 3: import a show log (Date, Time, Type, Cards Out, Cards In,
-- Cash In, Cash Out, Payment Method, Notes). See CLAUDE.md "Trades + Show Home".
-- Run after 20261119120000_show_home.sql. Re-runnable.
--
-- * inventory.identification_status: 'unidentified' on cards created from a log's
--   "Cards In" text. They aren't published to a show until the dealer adds details.
-- * import_show_log(): writes a whole reviewed log in one database transaction.
--   Each log row has an import_key; a row whose key was already imported is skipped,
--   so importing the same log twice adds nothing. show_log_imported_keys() tells the
--   review step which rows are already in.
--   Where each row goes (same rules as the fixture loader):
--     SOLD at a CardShow show  → the ledger (show_floor_transactions, source 'import');
--                                one card = sale, several = lot_sale.
--     SOLD at a private show, TRADE, BUY → dealer_transactions (source 'import').

begin;

-- ── 1. Cards that still need their details ──────────────────────────────────
alter table public.inventory add column if not exists identification_status text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_identification_status_check') then
    alter table public.inventory add constraint inventory_identification_status_check
      check (identification_status is null or identification_status = 'unidentified');
  end if;
end $$;
create index if not exists inventory_unidentified_idx on public.inventory (seller_id)
  where identification_status = 'unidentified';

-- ── 2. Helpers: write only the columns a table actually has ─────────────────
-- inventory and show_floor_transactions were built in the dashboard, so a column
-- the app writes may be missing on a given project. These skip unknown keys
-- (and generated columns) instead of failing.
create or replace function public._import_cols(p_table regclass, p_row jsonb)
returns text language sql stable set search_path = public as $$
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
    from pg_attribute a
   where a.attrelid = p_table and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
     and p_row ? a.attname;
$$;
revoke all on function public._import_cols(regclass, jsonb) from public, anon;
grant execute on function public._import_cols(regclass, jsonb) to authenticated;

create or replace function public._import_insert(p_table regclass, p_row jsonb)
returns uuid language plpgsql security invoker set search_path = public as $$
declare v_cols text := public._import_cols(p_table, p_row); v_id uuid;
begin
  execute format('insert into %s (%s) select %s from jsonb_populate_record(null::%s, $1) returning id',
                 p_table, v_cols, v_cols, p_table) into v_id using p_row;
  return v_id;
end;
$$;
revoke all on function public._import_insert(regclass, jsonb) from public, anon;
grant execute on function public._import_insert(regclass, jsonb) to authenticated;

create or replace function public._import_update_inventory(p_id uuid, p_vals jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare v_cols text := public._import_cols('public.inventory'::regclass, p_vals);
begin
  if v_cols is null then return; end if;
  execute format('update public.inventory set (%s) = (select %s from jsonb_populate_record(null::public.inventory, $1)) where id = $2',
                 v_cols, v_cols) using p_vals, p_id;
end;
$$;
revoke all on function public._import_update_inventory(uuid, jsonb) from public, anon;
grant execute on function public._import_update_inventory(uuid, jsonb) to authenticated;

-- ── 3. The import ───────────────────────────────────────────────────────────
-- p_txns: [{ key, occurred_at, txn_type ('sale'|'lot_sale'|'trade'|'buy'), cash_in, cash_out,
--            payment_method, note, local_date ('YYYY-MM-DD'), local_time ('2:15 PM'),
--            out: [{ inventory_id | ref, value, basis }],
--            in:  [{ ref, title, value, grader, grade, stock_code }] }]
-- ref: a key the review step gives each new "Cards In" card, so a later row in the
-- same log can trade that card away again (chained trades).
-- Returns { imported, duplicates: [key], created: [{ref, id, stock_code}] }.
-- Raises (and writes nothing) on a card that isn't the caller's, a card already
-- sold, or an unknown ref.
create or replace function public.import_show_log(p_show_id text, p_dealer_show_id uuid, p_txns jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_handle text;
  v_show jsonb;
  v_table text;
  t jsonb; o jsonb; n jsonb;
  v_key text; v_type text; v_at timestamptz; v_in numeric; v_out numeric; v_pm text;
  v_sk uuid; v_txn uuid; v_ledger boolean; v_dup uuid;
  v_inv record; v_id uuid; v_item uuid; v_cost numeric; v_code text;
  v_refs jsonb := '{}'::jsonb;
  v_imported int := 0;
  v_dups jsonb := '[]'::jsonb;
  v_created jsonb := '[]'::jsonb;
  v_outs jsonb;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  if (p_show_id is null) = (p_dealer_show_id is null) then raise exception 'pick_one_show'; end if;
  if jsonb_typeof(p_txns) <> 'array' then raise exception 'bad_payload'; end if;
  if p_dealer_show_id is not null and not exists (select 1 from public.dealer_shows where id = p_dealer_show_id and owner_id = v_uid) then
    raise exception 'show_not_found';
  end if;
  if p_show_id is not null then
    select to_jsonb(s) into v_show from public.shows s where s.id = p_show_id;
    if v_show is null then raise exception 'show_not_found'; end if;
    select table_number::text into v_table from public.show_sellers where show_id = p_show_id and seller_id = v_uid;
  end if;
  select handle into v_handle from public.sellers where id = v_uid;

  for t in select x from jsonb_array_elements(p_txns) x order by (x->>'occurred_at')::timestamptz, x->>'key' loop
    v_key  := nullif(t->>'key', '');
    v_type := t->>'txn_type';
    v_at   := coalesce((t->>'occurred_at')::timestamptz, now());
    v_in   := coalesce((t->>'cash_in')::numeric, 0);
    v_out  := coalesce((t->>'cash_out')::numeric, 0);
    v_pm   := nullif(t->>'payment_method', '');
    v_outs := coalesce(t->'out', '[]'::jsonb);
    if v_key is null then raise exception 'missing_key'; end if;
    if v_type not in ('sale', 'lot_sale', 'trade', 'buy') then raise exception 'bad_type %', v_key; end if;
    if v_in < 0 or v_out < 0 then raise exception 'bad_cash %', v_key; end if;
    if v_type in ('sale', 'lot_sale', 'trade') and jsonb_array_length(v_outs) = 0 then raise exception 'no_cards_out %', v_key; end if;
    if v_type = 'buy' and (jsonb_array_length(v_outs) > 0 or jsonb_array_length(coalesce(t->'in', '[]'::jsonb)) = 0) then
      raise exception 'bad_buy %', v_key;
    end if;
    v_ledger := p_show_id is not null and v_type in ('sale', 'lot_sale');
    v_sk := md5(v_uid::text || '|' || v_key)::uuid;           -- ledger client_sale_id for this row

    -- Already imported? Remember its new cards so later rows can still refer to them.
    select id into v_dup from public.dealer_transactions where owner_id = v_uid and import_key = v_key;
    if v_dup is null and exists (select 1 from public.show_floor_transactions where client_sale_id = v_sk) then v_dup := v_sk; end if;
    if v_dup is not null then
      v_dups := v_dups || to_jsonb(v_key);
      for n in select x from jsonb_array_elements(coalesce(t->'in', '[]'::jsonb)) x loop
        select inventory_id into v_id from public.transaction_items
         where dealer_txn_id = v_dup and direction = 'in' and card_ref->>'import_ref' = n->>'ref' limit 1;
        if v_id is not null then v_refs := v_refs || jsonb_build_object(n->>'ref', v_id); end if;
      end loop;
      continue;
    end if;

    -- Header
    if v_ledger then
      v_txn := null;
    else
      insert into public.dealer_transactions (owner_id, show_id, dealer_show_id, txn_type, occurred_at, cash_in, cash_out,
                                              payment_method, is_ungrouped, source, import_key, note)
      values (v_uid, p_show_id, p_dealer_show_id, v_type, v_at, v_in, v_out, v_pm,
              v_type = 'trade' and jsonb_array_length(coalesce(t->'in', '[]'::jsonb)) = 0, 'import', v_key, nullif(t->>'note', ''))
      returning id into v_txn;
    end if;

    -- Cards in (trades and buys): new inventory, cost = agreed value / price paid.
    if not v_ledger then
      for n in select x from jsonb_array_elements(coalesce(t->'in', '[]'::jsonb)) x loop
        v_id := public._import_insert('public.inventory'::regclass, jsonb_strip_nulls(jsonb_build_object(
          'seller_id', v_uid, 'card_title', nullif(trim(n->>'title'), ''), 'status', 'Available', 'item_type', 'card', 'price', 0,
          'grader', nullif(n->>'grader', ''), 'grade', nullif(n->>'grade', ''), 'identification_status', 'unidentified')));
        v_code := nullif(trim(n->>'stock_code'), '');
        if v_code is not null then
          begin
            update public.inventory set stock_code = v_code where id = v_id;
          exception when unique_violation then v_code := null;   -- taken: give it the next free code instead
          end;
        end if;
        if v_code is null then
          select a->>'stock_code' into v_code from jsonb_array_elements(public.assign_stock_codes(array[v_id])) a limit 1;
        end if;
        insert into public.inventory_costs (inventory_id, owner_id, cost_basis, acquired_at, acquired_from, acquired_txn_id)
        values (v_id, v_uid, nullif(n->>'value', '')::numeric, coalesce(nullif(t->>'local_date', '')::date, v_at::date), case when v_type = 'buy' then 'Buy' else 'Trade' end, v_txn)
        on conflict (inventory_id) do nothing;
        insert into public.transaction_items (sale_key, dealer_txn_id, owner_id, inventory_id, card_title, card_ref, price, price_basis,
                                              identification_status, direction)
        values (v_txn, v_txn, v_uid, v_id, nullif(trim(n->>'title'), ''),
                jsonb_build_object('stock_code', v_code, 'import_ref', n->>'ref'),
                nullif(n->>'value', '')::numeric, case when v_type = 'buy' then 'observed' else 'agreed_trade_value' end,
                'unidentified', 'in');
        if n->>'ref' is not null then v_refs := v_refs || jsonb_build_object(n->>'ref', v_id); end if;
        v_created := v_created || jsonb_build_object('ref', n->>'ref', 'id', v_id, 'stock_code', v_code);
      end loop;
    end if;

    -- Ledger header (sales at a CardShow show). One card: the ledger trigger adds its item.
    if v_ledger then
      if v_type = 'sale' and jsonb_array_length(v_outs) <> 1 then v_type := 'lot_sale'; end if;
      select i.* into v_inv from public.inventory i
       where i.id = coalesce((v_outs->0->>'inventory_id')::uuid, (v_refs->>(v_outs->0->>'ref'))::uuid);
      v_txn := public._import_insert('public.show_floor_transactions'::regclass, jsonb_strip_nulls(jsonb_build_object(
        'client_sale_id', v_sk, 'sold_at', v_at, 'sold_price', v_in, 'payment_method', coalesce(v_pm, 'Cash'),
        'source', 'import', 'txn_type', v_type, 'is_test', false, 'api_eligible', v_type = 'sale', 'data_version', 1,
        'inventory_id', case when v_type = 'sale' then v_inv.id end,
        'card_title', case when v_type = 'sale' then v_inv.card_title else 'Lot · ' || jsonb_array_length(v_outs) || ' cards' end,
        'player', case when v_type = 'sale' then v_inv.player end,
        'year', case when v_type = 'sale' then v_inv.year end,
        'card_set', case when v_type = 'sale' then v_inv.card_set end,
        'card_number', case when v_type = 'sale' then v_inv.card_number end,
        'parallel', case when v_type = 'sale' then v_inv.parallel end,
        'grader', case when v_type = 'sale' then v_inv.grader end,
        'grade', case when v_type = 'sale' then v_inv.grade end,
        'cert_number', case when v_type = 'sale' then v_inv.cert_number end,
        'asking_price', case when v_type = 'sale' then nullif(v_inv.price, 0) end,
        'item_type', case when v_type = 'sale' then coalesce(v_inv.item_type, 'card') else 'lot' end,
        'seller_id', v_uid, 'seller_handle', v_handle,
        'show_id', p_show_id, 'show_name', v_show->>'name',
        'show_date', coalesce(v_show->>'start_date', v_show->>'date'),
        'show_location', v_show->>'location', 'show_city', v_show->>'city', 'show_state', v_show->>'state',
        'table_number', v_table)));
    end if;

    -- Cards out
    for o in select x from jsonb_array_elements(v_outs) x loop
      v_id := coalesce((o->>'inventory_id')::uuid, (v_refs->>(o->>'ref'))::uuid);
      if v_id is null then raise exception 'unknown_card % (%)', coalesce(o->>'ref', '?'), v_key; end if;
      select i.* into v_inv from public.inventory i where i.id = v_id;
      if v_inv.id is null or v_inv.seller_id <> v_uid then raise exception 'not_your_card % (%)', v_id, v_key; end if;
      if v_inv.status = 'Sold' then raise exception 'already_sold % (%)', coalesce(v_inv.stock_code, v_inv.card_title), v_key; end if;
      select cost_basis into v_cost from public.inventory_costs where inventory_id = v_id;

      if v_ledger and v_type = 'sale' then
        -- The ledger trigger wrote the item; its cost comes through transaction_costs.
        if v_cost is not null then
          insert into public.transaction_costs (client_sale_id, owner_id, inventory_id, show_id, sale_price, cost_at_sale, sold_at)
          values (v_sk, v_uid, v_id, p_show_id, (o->>'value')::numeric, v_cost, v_at)
          on conflict (client_sale_id) do nothing;
        end if;
      else
        insert into public.transaction_items (sale_key, transaction_id, dealer_txn_id, owner_id, inventory_id, card_title, card_ref,
                                              price, price_basis, identification_status, direction)
        values (case when v_ledger then v_sk else v_txn end,
                case when v_ledger then v_txn end,
                case when v_ledger then null else v_txn end,
                v_uid, v_id, v_inv.card_title, jsonb_build_object('stock_code', v_inv.stock_code),
                nullif(o->>'value', '')::numeric,
                coalesce(nullif(o->>'basis', ''), case when v_type = 'trade' then 'agreed_trade_value'
                                                       when v_type = 'lot_sale' then 'allocated' else 'observed' end),
                'confirmed', 'out')
        returning id into v_item;
        if v_cost is not null then
          insert into public.transaction_item_costs (transaction_item_id, owner_id, cost_at_sale) values (v_item, v_uid, v_cost)
          on conflict (transaction_item_id) do nothing;
        end if;
      end if;

      perform public._import_update_inventory(v_id, jsonb_build_object(
        'status', 'Sold', 'sold_price', nullif(o->>'value', '')::numeric,
        'payment_method', case when v_type = 'trade' then 'Trade' else coalesce(v_pm, 'Cash') end,
        'sold_date', coalesce(nullif(t->>'local_date', ''), to_char(v_at, 'YYYY-MM-DD')),
        'sold_time', nullif(t->>'local_time', '')));
    end loop;

    v_imported := v_imported + 1;
  end loop;

  return jsonb_build_object('imported', v_imported, 'duplicates', v_dups, 'created', v_created);
end;
$$;
revoke all on function public.import_show_log(text, uuid, jsonb) from public, anon;
grant execute on function public.import_show_log(text, uuid, jsonb) to authenticated;

-- Which of these log rows has the caller already imported? (The review step greys them out.)
create or replace function public.show_log_imported_keys(p_keys text[])
returns text[] language sql stable security invoker set search_path = public as $$
  select coalesce(array_agg(k), '{}') from unnest(p_keys) k
   where exists (select 1 from public.dealer_transactions d where d.owner_id = auth.uid() and d.import_key = k)
      or exists (select 1 from public.show_floor_transactions t where t.client_sale_id = md5(auth.uid()::text || '|' || k)::uuid);
$$;
revoke all on function public.show_log_imported_keys(text[]) from public, anon;
grant execute on function public.show_log_imported_keys(text[]) to authenticated;

commit;
