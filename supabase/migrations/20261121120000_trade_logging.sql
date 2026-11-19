-- Trades + Show Home, Phase 4: log a trade or a buy from Show Mode.
-- See CLAUDE.md "Trades + Show Home" → "Phase 4". Run after 20261120120000_show_log_import.sql
-- (it uses that file's _import_insert / _import_update_inventory helpers). Re-runnable.
--
-- * record_trade(): one trade or buy, made on the phone and sent from the offline outbox.
--   Idempotent on p_client_id (dealer_transactions.client_capture_id): a retry returns the
--   first result and writes nothing. New "in" cards keep the ids the phone gave them, so the
--   phone can show them before the trade syncs.
-- * update_dealer_trade(): change a trade's cash, note and card values (not which cards).
-- * delete_dealer_trade(): undo a trade. Refused once a card that came in has been sold or
--   traded on, since its later sale would lose its cost.
-- Trades never touch show_floor_transactions (organizers see a count only).

begin;

-- p_txn: { txn_type ('trade'|'buy'), occurred_at, cash_in, cash_out, payment_method, note,
--          local_date ('YYYY-MM-DD'), local_time ('2:15 PM'),
--          out: [{ inventory_id, value }],
--          in:  [{ id, title, value, grader, grade, price, stock_code }] }
-- Returns { ok, id, already?, created: [{id, stock_code}] }
--      or { error: 'already_sold'|'not_your_card'|'unknown_card', card }.
create or replace function public.record_trade(p_client_id uuid, p_show_id text, p_dealer_show_id uuid, p_txn jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_type text := p_txn->>'txn_type';
  v_at timestamptz := coalesce(nullif(p_txn->>'occurred_at', '')::timestamptz, now());
  v_in numeric := coalesce(nullif(p_txn->>'cash_in', '')::numeric, 0);
  v_out numeric := coalesce(nullif(p_txn->>'cash_out', '')::numeric, 0);
  v_outs jsonb := coalesce(p_txn->'out', '[]'::jsonb);
  v_ins jsonb := coalesce(p_txn->'in', '[]'::jsonb);
  v_txn uuid; v_id uuid; v_item uuid; v_cost numeric; v_code text;
  v_inv record; o jsonb; n jsonb;
  v_created jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  if p_client_id is null then raise exception 'missing_client_id'; end if;
  if p_show_id is not null and p_dealer_show_id is not null then raise exception 'pick_one_show'; end if;
  if v_type not in ('trade', 'buy') then raise exception 'bad_type'; end if;
  if v_in < 0 or v_out < 0 then raise exception 'bad_cash'; end if;
  if v_type = 'trade' and jsonb_array_length(v_outs) = 0 then raise exception 'no_cards_out'; end if;
  if v_type = 'buy' and (jsonb_array_length(v_outs) > 0 or jsonb_array_length(v_ins) = 0) then raise exception 'bad_buy'; end if;

  -- A retry of a trade that already landed.
  select id into v_txn from public.dealer_transactions where client_capture_id = p_client_id and owner_id = v_uid;
  if v_txn is not null then
    select coalesce(jsonb_agg(jsonb_build_object('id', ti.inventory_id, 'stock_code', i.stock_code)), '[]'::jsonb)
      into v_created
      from public.transaction_items ti left join public.inventory i on i.id = ti.inventory_id
     where ti.dealer_txn_id = v_txn and ti.direction = 'in';
    return jsonb_build_object('ok', true, 'already', true, 'id', v_txn, 'created', v_created);
  end if;

  if p_dealer_show_id is not null and not exists (select 1 from public.dealer_shows where id = p_dealer_show_id and owner_id = v_uid) then
    raise exception 'show_not_found';
  end if;

  -- Check every card going out before writing anything.
  for o in select x from jsonb_array_elements(v_outs) x loop
    select i.* into v_inv from public.inventory i where i.id = nullif(o->>'inventory_id', '')::uuid;
    if v_inv.id is null then return jsonb_build_object('error', 'unknown_card', 'card', o->>'inventory_id'); end if;
    if v_inv.seller_id <> v_uid then return jsonb_build_object('error', 'not_your_card', 'card', v_inv.id); end if;
    if v_inv.status = 'Sold' then
      return jsonb_build_object('error', 'already_sold', 'card', v_inv.id, 'title', coalesce(v_inv.stock_code, v_inv.card_title));
    end if;
  end loop;

  insert into public.dealer_transactions (client_capture_id, owner_id, show_id, dealer_show_id, txn_type, occurred_at,
                                          cash_in, cash_out, payment_method, source, note)
  values (p_client_id, v_uid, p_show_id, p_dealer_show_id, v_type, v_at, v_in, v_out,
          nullif(p_txn->>'payment_method', ''), 'app', nullif(p_txn->>'note', ''))
  returning id into v_txn;

  -- Cards in: new inventory under the phone's id; cost = agreed value / price paid.
  for n in select x from jsonb_array_elements(v_ins) x loop
    v_id := public._import_insert('public.inventory'::regclass, jsonb_strip_nulls(jsonb_build_object(
      'id', nullif(n->>'id', '')::uuid,
      'seller_id', v_uid, 'card_title', coalesce(nullif(trim(n->>'title'), ''), 'Card from a ' || v_type),
      'status', 'Available', 'item_type', 'card', 'price', coalesce(nullif(n->>'price', '')::numeric, 0),
      'grader', nullif(n->>'grader', ''), 'grade', nullif(n->>'grade', ''),
      'source', 'show_mode', 'identification_status', 'unidentified')));
    v_code := nullif(trim(n->>'stock_code'), '');
    if v_code is not null then
      begin
        update public.inventory set stock_code = v_code where id = v_id;
      exception when unique_violation then v_code := null;     -- taken: the next free code instead
      end;
    end if;
    if v_code is null then
      select a->>'stock_code' into v_code from jsonb_array_elements(public.assign_stock_codes(array[v_id])) a limit 1;
    end if;
    insert into public.inventory_costs (inventory_id, owner_id, cost_basis, acquired_at, acquired_from, acquired_txn_id)
    values (v_id, v_uid, nullif(n->>'value', '')::numeric, coalesce(nullif(p_txn->>'local_date', '')::date, v_at::date),
            case when v_type = 'buy' then 'Buy' else 'Trade' end, v_txn)
    on conflict (inventory_id) do nothing;
    insert into public.transaction_items (sale_key, dealer_txn_id, owner_id, inventory_id, card_title, card_ref, price, price_basis,
                                          identification_status, direction)
    values (v_txn, v_txn, v_uid, v_id, coalesce(nullif(trim(n->>'title'), ''), 'Card from a ' || v_type),
            jsonb_build_object('stock_code', v_code), nullif(n->>'value', '')::numeric,
            case when v_type = 'buy' then 'observed' else 'agreed_trade_value' end, 'unidentified', 'in');
    v_created := v_created || jsonb_build_object('id', v_id, 'stock_code', v_code);
  end loop;

  -- Cards out.
  for o in select x from jsonb_array_elements(v_outs) x loop
    select i.* into v_inv from public.inventory i where i.id = (o->>'inventory_id')::uuid;
    select cost_basis into v_cost from public.inventory_costs where inventory_id = v_inv.id;
    insert into public.transaction_items (sale_key, dealer_txn_id, owner_id, inventory_id, card_title, card_ref,
                                          price, price_basis, identification_status, direction)
    values (v_txn, v_txn, v_uid, v_inv.id, v_inv.card_title, jsonb_build_object('stock_code', v_inv.stock_code),
            nullif(o->>'value', '')::numeric, 'agreed_trade_value', 'confirmed', 'out')
    returning id into v_item;
    if v_cost is not null then
      insert into public.transaction_item_costs (transaction_item_id, owner_id, cost_at_sale) values (v_item, v_uid, v_cost)
      on conflict (transaction_item_id) do nothing;
    end if;
    perform public._import_update_inventory(v_inv.id, jsonb_build_object(
      'status', 'Sold', 'sold_price', nullif(o->>'value', '')::numeric, 'payment_method', 'Trade',
      'sold_date', coalesce(nullif(p_txn->>'local_date', ''), to_char(v_at, 'YYYY-MM-DD')),
      'sold_time', nullif(p_txn->>'local_time', '')));
    delete from public.show_inventory where card_id = v_inv.id;   -- off the buyer pages
  end loop;

  return jsonb_build_object('ok', true, 'id', v_txn, 'created', v_created);
end;
$$;
revoke all on function public.record_trade(uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.record_trade(uuid, text, uuid, jsonb) to authenticated;

-- Change cash, note and card values. p_vals: { cash_in?, cash_out?, note?, items: [{ id, value }] }.
-- An "in" card's value is also its cost; an "out" card's value is also its sold price.
create or replace function public.update_dealer_trade(p_txn_id uuid, p_vals jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_txn record; it jsonb; v_item record; v_val numeric;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_txn from public.dealer_transactions where id = p_txn_id and owner_id = v_uid;
  if v_txn.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if coalesce(nullif(p_vals->>'cash_in', '')::numeric, 0) < 0 or coalesce(nullif(p_vals->>'cash_out', '')::numeric, 0) < 0 then
    raise exception 'bad_cash';
  end if;
  update public.dealer_transactions set
    cash_in  = case when p_vals ? 'cash_in'  then coalesce(nullif(p_vals->>'cash_in', '')::numeric, 0)  else cash_in end,
    cash_out = case when p_vals ? 'cash_out' then coalesce(nullif(p_vals->>'cash_out', '')::numeric, 0) else cash_out end,
    note     = case when p_vals ? 'note'     then nullif(p_vals->>'note', '') else note end,
    updated_at = now()
  where id = p_txn_id;
  for it in select x from jsonb_array_elements(coalesce(p_vals->'items', '[]'::jsonb)) x loop
    select * into v_item from public.transaction_items where id = (it->>'id')::uuid and dealer_txn_id = p_txn_id;
    if v_item.id is null then continue; end if;
    v_val := nullif(it->>'value', '')::numeric;
    update public.transaction_items set price = v_val, updated_at = now() where id = v_item.id;
    if v_item.direction = 'in' and v_item.inventory_id is not null then
      update public.inventory_costs set cost_basis = v_val where inventory_id = v_item.inventory_id and acquired_txn_id = p_txn_id;
    elsif v_item.direction = 'out' and v_item.inventory_id is not null then
      perform public._import_update_inventory(v_item.inventory_id, jsonb_build_object('sold_price', v_val));
    end if;
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.update_dealer_trade(uuid, jsonb) from public, anon;
grant execute on function public.update_dealer_trade(uuid, jsonb) to authenticated;

-- Undo a trade or buy: cards that went out are back in the case, cards that came in are
-- removed. Refused if a card that came in has since been sold or traded on.
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
    select v_txn.show_id, x from unnest(v_outs) x on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true, 'restored', to_jsonb(v_outs), 'removed', to_jsonb(v_ins));
end;
$$;
revoke all on function public.delete_dealer_trade(uuid) from public, anon;
grant execute on function public.delete_dealer_trade(uuid) to authenticated;

commit;
