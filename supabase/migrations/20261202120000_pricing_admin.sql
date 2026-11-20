-- Marketplace Phase 1: pricing admin (the "💲 Pricing" tab, platform owner only). Re-runnable.
-- Run after 20261130120000_marketplace_pricing_search.sql and 20261028120000_show_directory.sql.
--
-- 1. Access fix. 20261130120000 let is_cardshow_admin() read card_values, pricing_cards, pricing_api_usage and
--    agent_actions, and call pricing_unmatched / pricing_set_match. is_cardshow_admin() is anyone in `admins`,
--    i.e. every show organizer. These are now the platform owner's only (platform_admins), plus the service role.
-- 2. pricing_match_status 'ignored': the platform owner decided this card has no comp. Hidden from the queue,
--    never matched automatically.
-- 3. pricing_admin_summary(), pricing_unmatched(status, limit), pricing_admin_resolve(identity, action, ...).
--    Card Hedge lookups for a manual match go through netlify/functions/pricing-admin.js (the API key stays there).

begin;

create or replace function public._pricing_is_platform_admin() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if to_regclass('public.platform_admins') is null then return false; end if;
  return exists (select 1 from public.platform_admins where id = auth.uid());
end $$;
revoke all on function public._pricing_is_platform_admin() from public, anon;
grant execute on function public._pricing_is_platform_admin() to authenticated, service_role;

create or replace function public._pricing_is_admin() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return public._listing_is_service() or public._pricing_is_platform_admin();
end $$;
revoke all on function public._pricing_is_admin() from public, anon;

-- Read access to the pricing tables: platform owner only (was every organizer).
do $$ begin
  execute 'drop policy if exists pricing_cards_admin_read on public.pricing_cards';
  execute 'drop policy if exists card_values_admin_read on public.card_values';
  execute 'drop policy if exists pricing_api_usage_admin_read on public.pricing_api_usage';
  execute 'drop policy if exists agent_actions_admin_read on public.agent_actions';
end $$;
create policy pricing_cards_admin_read on public.pricing_cards for select to authenticated using (public._pricing_is_platform_admin());
create policy card_values_admin_read on public.card_values for select to authenticated using (public._pricing_is_platform_admin());
create policy pricing_api_usage_admin_read on public.pricing_api_usage for select to authenticated using (public._pricing_is_platform_admin());
create policy agent_actions_admin_read on public.agent_actions for select to authenticated using (public._pricing_is_platform_admin());
grant select on public.pricing_cards, public.card_values, public.pricing_api_usage, public.agent_actions to authenticated;
revoke insert, update, delete on public.pricing_cards, public.card_values, public.pricing_api_usage, public.agent_actions from authenticated;

-- 'ignored' status
alter table public.inventory drop constraint if exists inventory_pricing_match_status_check;
alter table public.inventory add constraint inventory_pricing_match_status_check
  check (pricing_match_status is null or pricing_match_status in ('matched','no_match','error','manual','ignored'));

-- Summary numbers for the tab.
create or replace function public.pricing_admin_summary()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public._pricing_is_admin() then raise exception 'admin_only'; end if;
  select jsonb_build_object(
    'listed', count(*),
    'priced', count(*) filter (where comp_value_cents is not null),
    'waiting', count(*) filter (where pricing_match_status is null),
    'no_comp_yet', count(*) filter (where pricing_match_status in ('matched','manual') and comp_value_cents is null),
    'unmatched', count(*) filter (where pricing_match_status in ('no_match','error')),
    'ignored', count(*) filter (where pricing_match_status = 'ignored'),
    'manual', count(*) filter (where pricing_match_status = 'manual'))
    into v
    from public.inventory
   where listing_status in ('active','reserved') and coalesce(item_type, 'card') = 'card';
  return v || jsonb_build_object(
    'cards', (select coalesce(jsonb_object_agg(priority, n), '{}'::jsonb)
                from (select priority, count(*) n from public.pricing_cards group by priority) t),
    'failing_refreshes', (select count(*) from public.pricing_cards where fail_count > 0),
    'last_refresh', (select max(refreshed_at) from public.pricing_cards),
    'usage_today', (select coalesce(jsonb_object_agg(provider, jsonb_build_object('calls', calls, 'uncached', uncached_calls,
                                                                                    'errors', errors, 'alert_sent_at', alert_sent_at)), '{}'::jsonb)
                      from public.pricing_api_usage where day = current_date));
end $$;

-- The queue: one row per card (pricing identity). p_status 'open' = couldn't match (no_match / error),
-- 'ignored' = hidden, 'manual' = matched by hand.
drop function if exists public.pricing_unmatched(int);
create or replace function public.pricing_unmatched(p_status text default 'open', p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public._pricing_is_admin() then raise exception 'admin_only'; end if;
  return coalesce((
    select jsonb_agg(row order by (row->>'listings')::int desc, row->>'oldest')
      from (
        select jsonb_strip_nulls(jsonb_build_object(
                 'identity', pricing_identity,
                 'status', max(pricing_match_status),
                 'listings', count(*),
                 'dealers', count(distinct seller_id),
                 'attempts', max(pricing_match_attempts),
                 'grades', to_jsonb(array_agg(distinct grade_key)),
                 'card_id', max(pricing_card_id),
                 'oldest', min(coalesce(listed_at, created_at)),
                 'card', (array_agg(jsonb_build_object('id', id, 'title', card_title, 'player', player, 'year', year,
                                                       'set', card_set, 'number', card_number, 'parallel', parallel,
                                                       'category', category, 'subcategory', subcategory)
                                    order by listed_at nulls last))[1])) as row
          from public.inventory
         where listing_status in ('active','reserved') and coalesce(pricing_identity, '') <> ''
           and case coalesce(p_status, 'open')
                 when 'ignored' then pricing_match_status = 'ignored'
                 when 'manual' then pricing_match_status = 'manual'
                 else pricing_match_status in ('no_match','error') end
         group by pricing_identity
         order by count(*) desc
         limit least(greatest(coalesce(p_limit, 100), 1), 500)) t), '[]'::jsonb);
end $$;

-- Resolve one card (every listing with that pricing identity).
--   'match'  p_card_id (+ p_query, p_title): link to that Card Hedge card; status 'manual'. The query is stored on
--            pricing_cards so scheduled refreshes use it. Values are stored by the caller (pricing_apply_values).
--   'retry'  back to the automatic queue (status null, attempts reset).
--   'ignore' hide it: no comp for this card ('ignored'); 'retry' brings it back.
create or replace function public.pricing_admin_resolve(p_identity text, p_action text, p_card_id text default null,
                                                        p_query text default null, p_title text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not public._pricing_is_admin() then raise exception 'admin_only'; end if;
  if coalesce(p_identity, '') = '' then raise exception 'identity_required'; end if;
  perform set_config('cardshow.pricing_fn', 'on', true);
  if p_action = 'match' then
    if coalesce(p_card_id, '') = '' then raise exception 'card_id_required'; end if;
    insert into public.pricing_cards (card_id, query, title, next_refresh_at)
    values (p_card_id, nullif(p_query, ''), nullif(p_title, ''), now())
    on conflict (card_id) do update set query = coalesce(excluded.query, pricing_cards.query),
                                        title = coalesce(excluded.title, pricing_cards.title),
                                        fail_count = 0, last_error = null,
                                        priority = case when pricing_cards.priority = 'dormant' then 'normal' else pricing_cards.priority end;
    update public.inventory set pricing_card_id = p_card_id, pricing_match_status = 'manual', pricing_matched_at = now(),
           comp_value_cents = case when pricing_card_id is distinct from p_card_id then null else comp_value_cents end,
           comp_refreshed_at = case when pricing_card_id is distinct from p_card_id then null else comp_refreshed_at end
     where pricing_identity = p_identity and listing_status <> 'sold';
    -- Fill comps right away from values already stored for this card.
    update public.inventory i set comp_value_cents = cv.value_cents, comp_refreshed_at = cv.refreshed_at
      from public.card_values cv
     where i.pricing_identity = p_identity and i.pricing_card_id = p_card_id and cv.card_id = p_card_id
       and cv.grade = i.grade_key and i.listing_status <> 'sold';
  elsif p_action = 'retry' then
    update public.inventory set pricing_match_status = null, pricing_match_attempts = 0, pricing_card_id = null,
           pricing_matched_at = null, comp_value_cents = null, comp_refreshed_at = null
     where pricing_identity = p_identity and pricing_match_status in ('no_match','error','ignored','manual');
  elsif p_action = 'ignore' then
    update public.inventory set pricing_match_status = 'ignored', pricing_card_id = null, pricing_matched_at = null,
           comp_value_cents = null, comp_refreshed_at = null
     where pricing_identity = p_identity and listing_status <> 'sold';
  else
    raise exception 'bad_action';
  end if;
  get diagnostics v_n = row_count;
  delete from public.pricing_identity_claims where identity = p_identity;
  perform set_config('cardshow.pricing_fn', 'off', true);
  return jsonb_build_object('ok', true, 'listings', v_n);
end $$;

-- The older helper keeps working, through the same rules.
create or replace function public.pricing_set_match(p_identity text, p_card_id text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return public.pricing_admin_resolve(p_identity, case when p_card_id is null then 'retry' else 'match' end, p_card_id);
end $$;

revoke all on function public.pricing_admin_summary(), public.pricing_unmatched(text, int),
                       public.pricing_admin_resolve(text, text, text, text, text), public.pricing_set_match(text, text)
  from public, anon;
grant execute on function public.pricing_admin_summary(), public.pricing_unmatched(text, int),
                          public.pricing_admin_resolve(text, text, text, text, text), public.pricing_set_match(text, text)
  to authenticated, service_role;

commit;

-- Check (run after): expect 4 rows, all using _pricing_is_platform_admin().
--   select tablename, policyname, qual from pg_policies where policyname like '%_admin_read'
--     and tablename in ('pricing_cards','card_values','pricing_api_usage','agent_actions');
