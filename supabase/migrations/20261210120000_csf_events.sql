-- The Card Shop Finder (CSF) events feed (session 2026-11-24). See CLAUDE.md "Card Shop Finder events".
-- Run after 20261209120000_marketplace_bundle_offers.sql (and the Show Directory, geocoding and show-pages
-- migrations it builds on). Re-runnable.
--
-- netlify/functions/sync-csf-events.js fetches the whole feed every 6 hours and hands it to csf_sync_apply(),
-- which in one transaction:
--   1. upserts external_events (listing facts only, url stored exactly as sent);
--   2. after a complete fetch (and only when it isn't suspicious: 0 events, or under half of the events active
--      before), marks events missing from the feed 'ended' (last day today or earlier, in the event's local date)
--      or 'removed' (still upcoming: cancelled or taken down);
--   3. turns active card_show / sports / convention events (list passed in) into CardShow shows: updates a linked
--      CSF show; links an organizer's show for the same event automatically when it's clearly the same, or queues
--      a match for review when it might be; else creates a show (source 'csf', listed, open to self-join);
--   4. hides a removed event's CSF show (listed = false, feed_removed_at), clears its pickup on dealers' cards and
--      queues one email per dealer with a listing picking it up and per buyer with an open hold or offer on those
--      cards. An organizer's own show linked to a removed event stays up and is only flagged;
--   5. restores an event that comes back (show listed again, no new emails).
-- CSF shows can only be changed by the sync and the platform owner (shows_feed_guard); an organizer isn't their
-- organizer (_show_inventory_is_organizer).
begin;

-- ── Tables ────────────────────────────────────────────────────────────────────────
create table if not exists public.external_events (
  id                uuid primary key default gen_random_uuid(),
  source            text not null default 'csf' check (source in ('csf')),
  source_event_id   bigint not null,
  name              text,
  event_type        text,
  date_start        date,
  date_end          date,
  time_start        text,
  time_end          text,
  venue             text,
  address           text,
  city              text,
  state             text,
  postal_code       text,
  lat               double precision,
  lng               double precision,
  admission_price   numeric(8,2),
  featured          boolean not null default false,
  source_updated_at timestamptz,
  source_url        text not null,
  status            text not null default 'active' check (status in ('active','ended','removed')),
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  removed_at        timestamptz,
  unique (source, source_event_id)
);
create index if not exists external_events_status_idx on public.external_events (source, status);

create table if not exists public.external_sync_runs (
  id              uuid primary key default gen_random_uuid(),
  source          text not null default 'csf',
  trigger         text,                         -- 'schedule' | 'manual'
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  ok              boolean,
  suspicious      boolean not null default false,
  http_status     integer,
  pages           integer,
  events_received integer,
  inserted        integer,
  updated         integer,
  removed         integer,
  ended           integer,
  restored        integer,
  shows_created   integer,
  shows_updated   integer,
  shows_linked    integer,
  matches_pending integer,
  by_type         jsonb,
  no_coords       integer,
  notices_queued  integer,
  emails_sent     integer,
  error           text
);
create index if not exists external_sync_runs_started_idx on public.external_sync_runs (source, started_at desc);

create table if not exists public.external_event_matches (
  id                uuid primary key default gen_random_uuid(),
  external_event_id uuid not null references public.external_events(id) on delete cascade,
  show_id           text not null references public.shows(id) on delete cascade,
  score             numeric,
  reasons           jsonb,
  status            text not null default 'pending' check (status in ('pending','linked','rejected')),
  created_at        timestamptz not null default now(),
  reviewed_by       uuid,
  reviewed_at       timestamptz,
  unique (external_event_id, show_id)
);

-- A show whose CSF event left the feed while still upcoming. kind 'hidden': a CSF show we took down;
-- 'flagged': an organizer's show linked to the event (left up, flagged for a look). One row per show, so the
-- emails go out once even if the event leaves, comes back and leaves again.
create table if not exists public.external_show_removals (
  id                uuid primary key default gen_random_uuid(),
  show_id           text not null unique references public.shows(id) on delete cascade,
  external_event_id uuid references public.external_events(id) on delete set null,
  kind              text not null check (kind in ('hidden','flagged')),
  removed_at        timestamptz not null default now(),
  restored_at       timestamptz,
  listings          jsonb not null default '[]'::jsonb,   -- [{id, title, stock_code, dealer_id, dealer}]
  holds             jsonb not null default '[]'::jsonb,   -- [{id, buyer_id, buyer_name, listing_ids}]
  offers            jsonb not null default '[]'::jsonb,   -- [{id, buyer_id, buyer_name, status, listing_ids}]
  handled_at        timestamptz,
  handled_by        uuid
);

create table if not exists public.external_show_notices (
  id          uuid primary key default gen_random_uuid(),
  removal_id  uuid not null references public.external_show_removals(id) on delete cascade,
  to_kind     text not null check (to_kind in ('dealer','buyer')),
  user_id     uuid not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  unique (removal_id, to_kind, user_id)
);

-- ── shows: where a show came from ─────────────────────────────────────────────────
alter table public.shows
  add column if not exists source text not null default 'cardshow',
  add column if not exists external_event_id uuid references public.external_events(id) on delete set null,
  add column if not exists feed_removed_at timestamptz,
  add column if not exists access_code text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shows_source_check') then
    alter table public.shows add constraint shows_source_check check (source in ('cardshow','csf'));
  end if;
end $$;
create unique index if not exists shows_external_event_idx on public.shows (external_event_id) where external_event_id is not null;
alter table public.shows drop constraint if exists shows_geo_source_check;
alter table public.shows add constraint shows_geo_source_check
  check (geo_source is null or geo_source in ('census_address','census_place','manual','not_found','csf'));

-- From the app, only the platform owner may touch a CSF show or the feed columns.
create or replace function public._shows_feed_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user not in ('anon', 'authenticated') then return coalesce(new, old); end if;
  if public._shows_is_platform_admin() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if new.source <> 'cardshow' or new.external_event_id is not null or new.feed_removed_at is not null then
      raise exception 'feed_show_locked' using errcode = '42501', hint = 'Shows from The Card Shop Finder are kept in sync automatically.';
    end if;
    return new;
  end if;
  if old.source = 'csf' then
    raise exception 'feed_show_locked' using errcode = '42501', hint = 'Shows from The Card Shop Finder are kept in sync automatically.';
  end if;
  if tg_op = 'UPDATE' and (new.source is distinct from old.source or new.external_event_id is distinct from old.external_event_id
                           or new.feed_removed_at is distinct from old.feed_removed_at) then
    raise exception 'feed_show_locked' using errcode = '42501', hint = 'Only CardShow links shows to The Card Shop Finder.';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists shows_feed_guard on public.shows;
create trigger shows_feed_guard before insert or update or delete on public.shows
  for each row execute function public._shows_feed_guard();

-- Organizer of a show (show_inventory / show_sellers writes): as 20261125120000, but nobody but the platform
-- owner organizes a CSF show (they have no created_by, which would otherwise mean "any organizer").
create or replace function public._show_inventory_is_organizer(p_show_id text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_owner uuid; v_found boolean; v_source text;
begin
  if v_uid is null then return false; end if;
  if to_regclass('public.platform_admins') is not null then
    execute 'select exists (select 1 from public.platform_admins where id = $1)' into v_found using v_uid;
    if v_found then return true; end if;
  end if;
  select (to_jsonb(s)->>'created_by')::uuid, coalesce(to_jsonb(s)->>'source', 'cardshow') into v_owner, v_source
    from public.shows s where s.id = p_show_id;
  if not found then return false; end if;
  if v_source = 'csf' then return false; end if;
  if v_owner is not null then return v_owner = v_uid; end if;
  if to_regclass('public.admins') is null then return false; end if;
  execute 'select exists (select 1 from public.admins where id = $1)' into v_found using v_uid;
  return v_found;
end $$;

-- ── Access ────────────────────────────────────────────────────────────────────────
alter table public.external_events enable row level security;
alter table public.external_sync_runs enable row level security;
alter table public.external_event_matches enable row level security;
alter table public.external_show_removals enable row level security;
alter table public.external_show_notices enable row level security;
drop policy if exists external_events_read on public.external_events;
create policy external_events_read on public.external_events for select to anon, authenticated using (true);
drop policy if exists external_sync_runs_admin on public.external_sync_runs;
create policy external_sync_runs_admin on public.external_sync_runs for select to authenticated using (public._shows_is_platform_admin());
drop policy if exists external_event_matches_admin on public.external_event_matches;
create policy external_event_matches_admin on public.external_event_matches for select to authenticated using (public._shows_is_platform_admin());
drop policy if exists external_show_removals_admin on public.external_show_removals;
create policy external_show_removals_admin on public.external_show_removals for select to authenticated using (public._shows_is_platform_admin());
revoke all on public.external_events, public.external_sync_runs, public.external_event_matches,
              public.external_show_removals, public.external_show_notices from anon, authenticated;
grant select on public.external_events to anon, authenticated;
grant select on public.external_sync_runs, public.external_event_matches, public.external_show_removals to authenticated;
grant all on public.external_events, public.external_sync_runs, public.external_event_matches,
             public.external_show_removals, public.external_show_notices to service_role;

-- ── Helpers ───────────────────────────────────────────────────────────────────────
-- Main time zone of a US state (same table as the app's DIR_STATE_TZ).
create or replace function public._us_state_tz(p_state text) returns text
language sql immutable as $$
  select case
    when upper(p_state) in ('CA','WA','OR','NV') then 'America/Los_Angeles'
    when upper(p_state) in ('CO','UT','NM','MT','WY','ID') then 'America/Denver'
    when upper(p_state) in ('TX','IL','MN','WI','MO','LA','OK','KS','NE','IA','AR','MS','AL','TN','SD','ND') then 'America/Chicago'
    when upper(p_state) in ('NY','NJ','PA','MA','CT','RI','VT','NH','ME','MD','DE','DC','VA','WV','NC','SC','GA','FL','OH','MI','IN','KY') then 'America/New_York'
    when upper(p_state) = 'AZ' then 'America/Phoenix'
    when upper(p_state) = 'HI' then 'Pacific/Honolulu'
    when upper(p_state) = 'AK' then 'America/Anchorage'
    when upper(p_state) = 'PR' then 'America/Puerto_Rico'
    else 'America/Los_Angeles' end
$$;

-- "Aug 29-30, 2026", as the app's _formatShowDateRange().
create or replace function public._show_date_text(p_start date, p_end date) returns text
language sql immutable as $$
  select case
    when p_start is null then null
    when p_end is null or p_end = p_start then to_char(p_start, 'Mon FMDD, YYYY')
    when date_trunc('month', p_start) = date_trunc('month', p_end) then to_char(p_start, 'Mon FMDD') || '-' || to_char(p_end, 'FMDD, YYYY')
    when extract(year from p_start) = extract(year from p_end) then to_char(p_start, 'Mon FMDD') || ' - ' || to_char(p_end, 'Mon FMDD, YYYY')
    else to_char(p_start, 'Mon FMDD, YYYY') || ' - ' || to_char(p_end, 'Mon FMDD, YYYY') end
$$;

-- Show name for matching: lower case, no years, ordinals, punctuation or "the"/"annual".
create or replace function public._csf_norm_name(p text) returns text
language sql immutable as $$
  select coalesce(nullif(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(p, '')),
           '&', ' and ', 'g'),
           '\m(19|20)[0-9]{2}\M|\m[0-9]+(st|nd|rd|th)\M', ' ', 'g'),
           '[^a-z0-9]+', ' ', 'g'),
           '\m(the|annual)\M', ' ', 'g')), ''), lower(coalesce(p, '')))
$$;

-- The CSF facts the public sees with a show (credit, times, admission), or just its source.
create or replace function public._show_feed(p_show_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when e.id is null then jsonb_build_object('source', coalesce(s.source, 'cardshow'))
    else jsonb_strip_nulls(jsonb_build_object(
      'source', s.source, 'source_url', e.source_url, 'attribution', 'via The Card Shop Finder',
      'time_start', e.time_start, 'time_end', e.time_end, 'admission_price', e.admission_price)) end
    from public.shows s left join public.external_events e on e.id = s.external_event_id
   where s.id = p_show_id
$$;
revoke all on function public._show_feed(text) from public, anon, authenticated;

create or replace function public._csf_random_code() returns text
language plpgsql volatile as $$
declare v text; n int := 0;
begin
  loop
    v := upper(substr(translate(md5(random()::text || clock_timestamp()::text), '01', ''), 1, 6));
    exit when length(v) = 6 and not exists (select 1 from public.shows where access_code = v);
    n := n + 1; exit when n > 20;
  end loop;
  return v;
end $$;

-- Takes a removed event's show down (or flags an organizer's show) and queues the emails, once per show.
create or replace function public._csf_take_down(p_show_id text, p_event uuid) returns int
language plpgsql security definer set search_path = public as $$
declare s record; v_removal uuid; v_ids uuid[]; v_listings jsonb; v_holds jsonb; v_offers jsonb; v_new int := 0; v_buyers int := 0; v_name text;
begin
  select * into s from public.shows where id = p_show_id for update;
  if s is null then return 0; end if;
  if s.source <> 'csf' then
    insert into public.external_show_removals (show_id, external_event_id, kind)
    values (s.id, p_event, 'flagged')
    on conflict (show_id) do update set removed_at = case when external_show_removals.restored_at is null
                                                         then external_show_removals.removed_at else now() end,
                                        restored_at = null;
    return 0;
  end if;

  update public.shows set listed = false, feed_removed_at = now() where id = s.id;

  -- Cards picking this show up: listings for sale or on hold.
  select coalesce(array_agg(i.id), '{}') into v_ids from public.inventory i
   where i.pickup_show_id = s.id and i.listing_status in ('active','reserved');
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', i.id, 'title', i.card_title,
           'stock_code', to_jsonb(i)->>'stock_code', 'dealer_id', i.seller_id, 'dealer', sl.handle,
           'listing_status', i.listing_status,
           'url', '/c/' || i.id || '-' || public._listing_slug(i.card_title))) order by i.card_title), '[]'::jsonb)
    into v_listings
    from public.inventory i left join public.sellers sl on sl.id = i.seller_id where i.id = any(v_ids);
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'buyer_id', r.buyer_id, 'buyer_name', r.buyer_name,
           'dealer_id', r.dealer_id,
           'listing_ids', (select coalesce(jsonb_agg(i.id), '[]'::jsonb) from public.inventory i where i.reservation_id = r.id))), '[]'::jsonb)
    into v_holds
    from public.listing_reservations r
   where r.status = 'active' and exists (select 1 from public.inventory i where i.reservation_id = r.id and i.id = any(v_ids));
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'buyer_id', o.buyer_id, 'buyer_name', o.buyer_name,
           'dealer_id', o.dealer_id, 'status', o.status, 'listing_ids', to_jsonb(o.listing_ids))), '[]'::jsonb)
    into v_offers
    from public.offers o where o.status in ('pending','countered') and o.listing_ids && v_ids;

  insert into public.external_show_removals (show_id, external_event_id, kind, listings, holds, offers)
  values (s.id, p_event, 'hidden', v_listings, v_holds, v_offers)
  on conflict (show_id) do update set
    removed_at = now(), restored_at = null, handled_at = null,
    listings = excluded.listings, holds = excluded.holds, offers = excluded.offers
  returning id into v_removal;

  -- The pickup option for this show goes; shipping (sale_modes) is untouched.
  update public.inventory set pickup_show_id = null where pickup_show_id = s.id;

  v_name := s.name;
  -- One email per dealer with listings here, one per buyer with an open hold or offer on them. Never twice.
  insert into public.external_show_notices (removal_id, to_kind, user_id, payload)
  select v_removal, 'dealer', d.dealer_id::uuid,
         jsonb_build_object('show_name', v_name, 'show_date', s.date, 'show_city', s.city, 'show_state', s.state,
                            'cards', d.cards,
                            'holds', (select count(*) from jsonb_array_elements(v_holds) h where h->>'dealer_id' = d.dealer_id),
                            'offers', (select count(*) from jsonb_array_elements(v_offers) o where o->>'dealer_id' = d.dealer_id))
    from (select l->>'dealer_id' as dealer_id, jsonb_agg(l - 'dealer_id' - 'dealer' order by l->>'title') as cards
            from jsonb_array_elements(v_listings) l group by l->>'dealer_id') d
  on conflict (removal_id, to_kind, user_id) do nothing;
  get diagnostics v_new = row_count;

  insert into public.external_show_notices (removal_id, to_kind, user_id, payload)
  select v_removal, 'buyer', (b.buyer_id)::uuid,
         jsonb_build_object('show_name', v_name, 'show_date', s.date, 'show_city', s.city, 'show_state', s.state,
           'cards', (select coalesce(jsonb_agg(l order by l->>'title'), '[]'::jsonb) from jsonb_array_elements(v_listings) l
                      where (l->>'id') = any(b.ids)),
           'dealer', (select coalesce(nullif(sl.display_name, ''), sl.handle) from public.sellers sl where sl.id = b.dealer_id::uuid))
    from (select x->>'buyer_id' as buyer_id, min(x->>'dealer_id') as dealer_id,
                 array_agg(distinct y.v) as ids
            from (select * from jsonb_array_elements(v_holds) union all select * from jsonb_array_elements(v_offers)) t(x)
            cross join lateral jsonb_array_elements_text(x->'listing_ids') y(v)
           group by x->>'buyer_id') b
  on conflict (removal_id, to_kind, user_id) do nothing;
  get diagnostics v_buyers = row_count;
  return v_new + v_buyers;
end $$;
revoke all on function public._csf_take_down(text, uuid) from public, anon, authenticated;

-- ── The sync ──────────────────────────────────────────────────────────────────────
-- p_events: every event from one complete fetch. p_show_types: event types that become shows.
-- Returns the counts (also written to external_sync_runs when p_run_id is given).
create or replace function public.csf_sync_apply(p_events jsonb, p_show_types text[], p_run_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  e jsonb; ev record; r record; c record; s record;
  v_received int := 0; v_active_before int; v_suspicious boolean := false;
  v_inserted int := 0; v_updated int := 0; v_removed int := 0; v_ended int := 0; v_restored int := 0;
  v_created int := 0; v_shows_updated int := 0; v_linked int := 0; v_pending int := 0; v_notices int := 0;
  v_skipped int := 0; v_no_coords int := 0; v_ids bigint[] := '{}'; v_by_type jsonb := '{}'::jsonb;
  v_prev text; v_xmax xid; v_today date; v_show_id text; v_sim numeric; v_miles numeric; v_city boolean;
  v_best record; v_have boolean; v_slug text; v_lat double precision; v_lng double precision;
begin
  if jsonb_typeof(p_events) <> 'array' then return jsonb_build_object('error', 'bad_events'); end if;
  select count(*) into v_active_before from public.external_events where source = 'csf' and status = 'active';

  -- 1. Upsert every event.
  for e in select * from jsonb_array_elements(p_events) loop
    begin
      if (e->>'id') !~ '^[0-9]+$' or nullif(btrim(coalesce(e->>'url', '')), '') is null
         or (e->>'date_start') !~ '^\d{4}-\d{2}-\d{2}$' then
        v_skipped := v_skipped + 1; continue;
      end if;
      select status into v_prev from public.external_events where source = 'csf' and source_event_id = (e->>'id')::bigint;
      insert into public.external_events (source, source_event_id, name, event_type, date_start, date_end, time_start, time_end,
             venue, address, city, state, postal_code, lat, lng, admission_price, featured, source_updated_at, source_url,
             status, last_seen_at, removed_at)
      values ('csf', (e->>'id')::bigint, nullif(btrim(e->>'name'), ''), lower(e->>'type'),
             (e->>'date_start')::date, coalesce(nullif(e->>'date_end', '')::date, (e->>'date_start')::date),
             nullif(e->>'time_start', ''), nullif(e->>'time_end', ''),
             nullif(btrim(e->>'venue'), ''), nullif(btrim(e->>'address'), ''), nullif(btrim(e->>'city'), ''),
             nullif(upper(btrim(e->>'state')), ''), nullif(btrim(e->>'postal_code'), ''),
             nullif(e->>'lat', '')::double precision, nullif(e->>'lng', '')::double precision,
             nullif(e->>'admission_price', '')::numeric, coalesce((e->>'featured')::boolean, false),
             nullif(e->>'updated_at', '')::timestamptz, e->>'url', 'active', now(), null)
      on conflict (source, source_event_id) do update set
             name = excluded.name, event_type = excluded.event_type, date_start = excluded.date_start, date_end = excluded.date_end,
             time_start = excluded.time_start, time_end = excluded.time_end, venue = excluded.venue, address = excluded.address,
             city = excluded.city, state = excluded.state, postal_code = excluded.postal_code, lat = excluded.lat, lng = excluded.lng,
             admission_price = excluded.admission_price, featured = excluded.featured,
             source_updated_at = excluded.source_updated_at, source_url = excluded.source_url,
             status = 'active', last_seen_at = now(), removed_at = null;
      v_received := v_received + 1;
      v_ids := v_ids || (e->>'id')::bigint;
      v_by_type := jsonb_set(v_by_type, array[coalesce(lower(e->>'type'), 'unknown')],
                             to_jsonb(coalesce((v_by_type->>coalesce(lower(e->>'type'), 'unknown'))::int, 0) + 1));
      if v_prev is null then v_inserted := v_inserted + 1; else v_updated := v_updated + 1; end if;
      if v_prev = 'removed' then
        v_restored := v_restored + 1;
        -- An event back in the feed: its show comes back, no new emails.
        update public.shows set listed = true, feed_removed_at = null
         where external_event_id = (select id from public.external_events where source = 'csf' and source_event_id = (e->>'id')::bigint)
           and feed_removed_at is not null;
        update public.external_show_removals set restored_at = now()
         where external_event_id = (select id from public.external_events where source = 'csf' and source_event_id = (e->>'id')::bigint)
           and restored_at is null;
      end if;
    exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  -- 2. Events no longer in the feed (only when this fetch looks whole).
  v_suspicious := v_received = 0 or v_received < v_active_before * 0.5;
  if not v_suspicious then
    for ev in select x.* from public.external_events x
               where x.source = 'csf' and x.status = 'active' and not (x.source_event_id = any(v_ids)) loop
      v_today := (now() at time zone public._us_state_tz(ev.state))::date;
      if coalesce(ev.date_end, ev.date_start) <= v_today then
        update public.external_events set status = 'ended' where id = ev.id;
        v_ended := v_ended + 1;
      else
        update public.external_events set status = 'removed', removed_at = now() where id = ev.id;
        v_removed := v_removed + 1;
        for r in select id from public.shows where external_event_id = ev.id loop
          v_notices := v_notices + public._csf_take_down(r.id, ev.id);
        end loop;
      end if;
    end loop;
  end if;

  -- 3. Shows for active events of the chosen types.
  for ev in select x.* from public.external_events x
             where x.source = 'csf' and x.status = 'active' and x.source_event_id = any(v_ids)
               and x.event_type = any(p_show_types) and x.date_start is not null and x.name is not null
               and x.city is not null and x.state is not null loop
    select * into s from public.shows where external_event_id = ev.id;
    if s.id is not null then
      if s.source = 'csf' then
        update public.shows set
          name = ev.name, start_date = ev.date_start, end_date = ev.date_end,
          date = public._show_date_text(ev.date_start, ev.date_end),
          venue = ev.venue, city = ev.city, state = ev.state, street_address = ev.address, postal_code = ev.postal_code,
          location = concat_ws(', ', ev.venue, ev.city, ev.state),
          timezone = public._us_state_tz(ev.state),
          latitude = case when ev.lat is not null then ev.lat else latitude end,
          longitude = case when ev.lng is not null then ev.lng else longitude end,
          geo_source = case when ev.lat is not null then 'csf' else geo_source end,
          geocoded_at = case when ev.lat is not null and geo_source is distinct from 'csf' then now() else geocoded_at end,
          status = case when ev.date_start > (now() at time zone public._us_state_tz(ev.state))::date then 'upcoming'
                        when ev.date_end < (now() at time zone public._us_state_tz(ev.state))::date then 'past' else 'active' end
         where id = s.id
           and (name, start_date, end_date, venue, city, state, street_address, postal_code, latitude, longitude)
               is distinct from (ev.name, ev.date_start, ev.date_end, ev.venue, ev.city, ev.state, ev.address, ev.postal_code,
                                 coalesce(ev.lat, s.latitude), coalesce(ev.lng, s.longitude));
        if found then v_shows_updated := v_shows_updated + 1; end if;
      end if;
      continue;
    end if;
    -- Waiting for a person to decide.
    if exists (select 1 from public.external_event_matches m where m.external_event_id = ev.id and m.status = 'pending') then
      continue;
    end if;

    -- An organizer's show for the same event?
    select x.id, x.name, x.city, x.latitude, x.longitude,
             similarity(public._csf_norm_name(x.name), public._csf_norm_name(ev.name)) as sim,
             (lower(btrim(coalesce(x.city, ''))) = lower(btrim(ev.city))) as same_city,
             case when x.latitude is not null and ev.lat is not null
                  then public._miles(ev.lat::numeric, ev.lng::numeric, x.latitude::numeric, x.longitude::numeric) end as miles
        from public.shows x
       where x.source = 'cardshow' and x.external_event_id is null
         and nullif(to_jsonb(x)->>'merged_into', '') is null
         and x.start_date is not null
         and x.start_date <= ev.date_end and coalesce(x.end_date, x.start_date) >= ev.date_start
         and upper(btrim(coalesce(x.state, ''))) = ev.state
         and not exists (select 1 from public.external_event_matches m
                          where m.external_event_id = ev.id and m.show_id = x.id and m.status = 'rejected')
       order by sim desc
       limit 1
      into v_best;
    v_have := found;

    if v_have and v_best.sim >= 0.6 and (v_best.same_city or coalesce(v_best.miles <= 1, false)) then
      update public.shows set external_event_id = ev.id where id = v_best.id;
      insert into public.external_event_matches (external_event_id, show_id, score, reasons, status, reviewed_at)
      values (ev.id, v_best.id, round(v_best.sim::numeric, 3),
              jsonb_build_object('auto', true, 'name_similarity', round(v_best.sim::numeric, 3), 'same_city', v_best.same_city,
                                 'miles', round(v_best.miles, 2), 'dates_overlap', true, 'same_state', true),
              'linked', now())
      on conflict (external_event_id, show_id) do update set status = 'linked', score = excluded.score, reasons = excluded.reasons;
      v_linked := v_linked + 1;
      continue;
    end if;
    if v_have and v_best.sim >= 0.3 then
      insert into public.external_event_matches (external_event_id, show_id, score, reasons, status)
      values (ev.id, v_best.id, round(v_best.sim::numeric, 3),
              jsonb_build_object('name_similarity', round(v_best.sim::numeric, 3), 'same_city', v_best.same_city,
                                 'miles', round(v_best.miles, 2), 'dates_overlap', true, 'same_state', true),
              'pending')
      on conflict (external_event_id, show_id) do nothing;
      v_pending := v_pending + 1;
      continue;
    end if;

    -- A new show.
    v_show_id := 'show_csf' || ev.source_event_id;
    v_slug := public._show_slug(ev.name, ev.date_start, v_show_id);
    insert into public.shows (id, name, date, start_date, end_date, status, location, venue, city, state,
                              street_address, postal_code, timezone, latitude, longitude, geo_source, geocoded_at,
                              listed, listed_at, slug, seller_self_join, source, external_event_id, access_code)
    values (v_show_id, ev.name, public._show_date_text(ev.date_start, ev.date_end), ev.date_start, ev.date_end,
            case when ev.date_start > (now() at time zone public._us_state_tz(ev.state))::date then 'upcoming' else 'active' end,
            concat_ws(', ', ev.venue, ev.city, ev.state), ev.venue, ev.city, ev.state, ev.address, ev.postal_code,
            public._us_state_tz(ev.state), ev.lat, ev.lng, case when ev.lat is not null then 'csf' end,
            case when ev.lat is not null then now() end,
            true, now(), v_slug, true, 'csf', ev.id, public._csf_random_code())
    on conflict (id) do update set external_event_id = ev.id, source = 'csf', listed = true, feed_removed_at = null;
    v_created := v_created + 1;
  end loop;

  select count(*) into v_no_coords from public.shows
   where source = 'csf' and feed_removed_at is null and latitude is null
     and coalesce(end_date, start_date) >= current_date - 1;

  if p_run_id is not null then
    update public.external_sync_runs set
      events_received = v_received, inserted = v_inserted, updated = v_updated, removed = v_removed, ended = v_ended,
      restored = v_restored, shows_created = v_created, shows_updated = v_shows_updated, shows_linked = v_linked,
      matches_pending = v_pending, by_type = v_by_type, no_coords = v_no_coords, notices_queued = v_notices,
      suspicious = v_suspicious,
      error = case when v_suspicious then format('Suspicious fetch: %s events, %s were active. Nothing was marked removed.',
                                                 v_received, v_active_before) end
     where id = p_run_id;
  end if;

  return jsonb_build_object('received', v_received, 'skipped', v_skipped, 'inserted', v_inserted, 'updated', v_updated,
    'removed', v_removed, 'ended', v_ended, 'restored', v_restored, 'shows_created', v_created,
    'shows_updated', v_shows_updated, 'shows_linked', v_linked, 'matches_pending', v_pending,
    'notices_queued', v_notices, 'suspicious', v_suspicious, 'active_before', v_active_before,
    'by_type', v_by_type, 'no_coords', v_no_coords);
end $$;
revoke all on function public.csf_sync_apply(jsonb, text[], uuid) from public, anon, authenticated;
grant execute on function public.csf_sync_apply(jsonb, text[], uuid) to service_role;

-- ── Emails ────────────────────────────────────────────────────────────────────────
create or replace function public.show_feed_notices_due(p_limit int default 50)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'to', n.to_kind, 'email', u.email, 'payload', n.payload,
                                               'source_url', e.source_url) order by n.created_at), '[]'::jsonb)
    from (select * from public.external_show_notices where sent_at is null and created_at > now() - interval '3 days'
           order by created_at limit greatest(1, least(p_limit, 200))) n
    join public.external_show_removals r on r.id = n.removal_id
    left join public.external_events e on e.id = r.external_event_id
    left join auth.users u on u.id = n.user_id
$$;
create or replace function public.show_feed_notice_sent(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.external_show_notices set sent_at = now() where id = p_id and sent_at is null
$$;
revoke all on function public.show_feed_notices_due(int), public.show_feed_notice_sent(uuid) from public, anon, authenticated;
grant execute on function public.show_feed_notices_due(int), public.show_feed_notice_sent(uuid) to service_role;

-- ── Admin (platform owner) ────────────────────────────────────────────────────────
create or replace function public.csf_feed_admin() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._shows_is_platform_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  return jsonb_build_object(
    'runs', (select coalesce(jsonb_agg(to_jsonb(r) order by r.started_at desc), '[]'::jsonb)
               from (select * from public.external_sync_runs where source = 'csf' order by started_at desc limit 10) r),
    'counts', jsonb_build_object(
      'active_events', (select count(*) from public.external_events where source = 'csf' and status = 'active'),
      'csf_shows', (select count(*) from public.shows where source = 'csf' and feed_removed_at is null
                       and coalesce(end_date, start_date) >= current_date),
      'linked_shows', (select count(*) from public.shows where source = 'cardshow' and external_event_id is not null),
      'no_coords', (select count(*) from public.shows where source = 'csf' and feed_removed_at is null and latitude is null
                       and coalesce(end_date, start_date) >= current_date)),
    'matches', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', m.id, 'score', m.score, 'reasons', m.reasons, 'created_at', m.created_at,
                   'event', jsonb_build_object('name', e.name, 'type', e.event_type, 'date_start', e.date_start, 'date_end', e.date_end,
                                               'venue', e.venue, 'city', e.city, 'state', e.state, 'url', e.source_url),
                   'show', jsonb_build_object('id', s.id, 'name', s.name, 'start_date', s.start_date, 'end_date', s.end_date,
                                              'venue', s.venue, 'city', s.city, 'state', s.state, 'listed', to_jsonb(s)->>'listed'))
                 order by e.date_start), '[]'::jsonb)
                  from public.external_event_matches m
                  join public.external_events e on e.id = m.external_event_id
                  join public.shows s on s.id = m.show_id
                 where m.status = 'pending'),
    'removals', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', x.id, 'kind', x.kind, 'removed_at', x.removed_at, 'restored_at', x.restored_at, 'handled_at', x.handled_at,
                   'show', jsonb_build_object('id', s.id, 'name', s.name, 'date', s.date, 'city', s.city, 'state', s.state),
                   'listings', x.listings, 'holds', x.holds, 'offers', x.offers,
                   'emails', (select jsonb_build_object('queued', count(*), 'sent', count(sent_at))
                                from public.external_show_notices n where n.removal_id = x.id))
                 order by x.removed_at desc), '[]'::jsonb)
                  from public.external_show_removals x join public.shows s on s.id = x.show_id
                 where x.handled_at is null or x.removed_at > now() - interval '14 days'));
end $$;

create or replace function public.csf_resolve_match(p_match uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  if not public._shows_is_platform_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  select * into m from public.external_event_matches where id = p_match for update;
  if m is null then return jsonb_build_object('error', 'not_found'); end if;
  if m.status <> 'pending' then return jsonb_build_object('error', 'already_' || m.status); end if;
  if p_action = 'link' then
    if exists (select 1 from public.shows where external_event_id = m.external_event_id) then
      return jsonb_build_object('error', 'event_already_linked');
    end if;
    if exists (select 1 from public.shows where id = m.show_id and (external_event_id is not null or source <> 'cardshow')) then
      return jsonb_build_object('error', 'show_already_linked');
    end if;
    update public.shows set external_event_id = m.external_event_id where id = m.show_id;
    update public.external_event_matches set status = 'linked', reviewed_by = auth.uid(), reviewed_at = now() where id = m.id;
    update public.external_event_matches set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
     where external_event_id = m.external_event_id and status = 'pending' and id <> m.id;
    return jsonb_build_object('ok', true, 'status', 'linked');
  elsif p_action = 'reject' then
    update public.external_event_matches set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now() where id = m.id;
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;
  return jsonb_build_object('error', 'bad_action');
end $$;

create or replace function public.csf_removal_handled(p_removal uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public._shows_is_platform_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  update public.external_show_removals set handled_at = now(), handled_by = auth.uid() where id = p_removal;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.csf_feed_admin(), public.csf_resolve_match(uuid, text), public.csf_removal_handled(uuid) from public, anon;
grant execute on function public.csf_feed_admin(), public.csf_resolve_match(uuid, text), public.csf_removal_handled(uuid) to authenticated, service_role;

-- ── Public show data gains the CSF credit, times and admission ─────────────────────
-- As 20261206120000, plus the feed fields; a CSF show taken down isn't a card's "next show".
create or replace function public._listing_next_show(p_card uuid, p_pickup text)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(x) || public._show_feed(x.id) from (
    select s.id, s.name, coalesce(s.start_date, null) as start_date, coalesce(s.end_date, s.start_date) as end_date,
           s.city, s.state, s.venue, s.latitude, s.longitude,
           (select ss.table_number from public.show_sellers ss join public.inventory i on i.seller_id = ss.seller_id
             where ss.show_id = s.id and i.id = p_card limit 1) as table_number,
           '/s/' || coalesce(nullif(to_jsonb(s)->>'slug', ''), s.id) as url,
           (s.id = p_pickup) as pickup
      from public.shows s
     where (s.id = p_pickup or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = p_card))
       and coalesce(s.end_date, s.start_date, current_date) >= current_date
       and s.feed_removed_at is null
     order by (s.id = p_pickup) desc, s.start_date nulls last
     limit 1) x
$$;
revoke all on function public._listing_next_show(uuid, text) from public, anon, authenticated;

-- As 20261206120000, plus the feed fields.
create or replace function public.list_upcoming_shows(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_lat numeric := nullif(p->'near'->>'lat', '')::numeric;
  v_lng numeric := nullif(p->'near'->>'lng', '')::numeric;
  v_miles numeric := least(coalesce(nullif(p->'near'->>'miles', '')::numeric, 50), 1000);
  v_from date := coalesce(nullif(p->>'date_from', '')::date, current_date);
  v_to date := nullif(p->>'date_to', '')::date;
  v_state text := nullif(upper(btrim(p->>'state')), '');
  v_limit int := least(greatest(coalesce((p->>'limit')::int, 20), 1), 50);
begin
  return coalesce((
    select jsonb_agg(row order by row->>'start_date' nulls last, row->>'name')
      from (
        select jsonb_strip_nulls(jsonb_build_object(
                 'id', s.id, 'name', s.name, 'start_date', s.start_date, 'end_date', coalesce(s.end_date, s.start_date),
                 'venue', s.venue, 'city', s.city, 'state', s.state,
                 'miles', round(public._miles(v_lat, v_lng, s.latitude, s.longitude), 1),
                 'listed_cards', (select count(distinct i.id) from public.inventory i
                                   where (i.pickup_show_id = s.id or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = i.id))
                                     and public._listing_is_public(i.status, i.listing_status, i.early_access_until, to_jsonb(i)->>'trust_flag')),
                 'url', '/s/' || coalesce(nullif(to_jsonb(s)->>'slug', ''), s.id))) || public._show_feed(s.id) as row
          from public.shows s
         where coalesce(to_jsonb(s)->>'listed', 'true') <> 'false'
           and nullif(to_jsonb(s)->>'merged_into', '') is null
           and s.feed_removed_at is null
           and s.start_date is not null
           and coalesce(s.end_date, s.start_date) >= v_from
           and (v_to is null or s.start_date <= v_to)
           and (v_state is null or upper(s.state) = v_state)
           and (v_lat is null or public._miles(v_lat, v_lng, s.latitude, s.longitude) <= v_miles)
         order by s.start_date, s.name
         limit v_limit) t), '[]'::jsonb);
end $$;

-- As 20261206120000, plus the feed fields and removed (a CSF show taken down: the page says so).
create or replace function public.get_show_page(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s record; sj jsonb; v_key text; v_target text; v_dealers jsonb; v_count int;
begin
  if nullif(btrim(coalesce(p_key, '')), '') is null or length(p_key) > 120 then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into s from public.shows x where to_jsonb(x)->>'slug' = p_key limit 1;
  if s is null then select * into s from public.shows where id = p_key; end if;
  if s is null then return jsonb_build_object('error', 'not_found'); end if;
  sj := to_jsonb(s);
  v_target := nullif(sj->>'merged_into', '');
  if v_target is not null and v_target <> s.id and exists (select 1 from public.shows where id = v_target) then
    return jsonb_build_object('redirect', '/s/' || public._show_public_key(v_target));
  end if;
  v_key := coalesce(nullif(sj->>'slug', ''), s.id);
  if v_key <> p_key then return jsonb_build_object('redirect', '/s/' || v_key); end if;

  select coalesce(jsonb_agg(d order by (d->>'listings')::int desc, lower(d->>'display_name')), '[]'::jsonb) into v_dealers
    from (
      select jsonb_strip_nulls(jsonb_build_object(
               'handle', sl.handle,
               'display_name', coalesce(nullif(sl.display_name, ''), sl.handle),
               'table_number', nullif(btrim(coalesce(ss.table_number, '')), ''),
               'url', '/d/' || sl.handle,
               'listings', (select count(*) from public.inventory i
                             where i.seller_id = sl.id
                               and (i.pickup_show_id = s.id or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = i.id))
                               and public._listing_is_public(i.status, i.listing_status, i.early_access_until, to_jsonb(i)->>'trust_flag')))) as d
        from public.show_sellers ss join public.sellers sl on sl.id = ss.seller_id
       where ss.show_id = s.id and sl.handle is not null) t;

  select count(distinct i.id) into v_count from public.inventory i
   where (i.pickup_show_id = s.id or exists (select 1 from public.show_inventory si where si.show_id = s.id and si.card_id = i.id))
     and public._listing_is_public(i.status, i.listing_status, i.early_access_until, to_jsonb(i)->>'trust_flag');

  return jsonb_strip_nulls(jsonb_build_object(
    'id', s.id, 'key', v_key, 'url', '/s/' || v_key, 'name', s.name,
    'start_date', s.start_date, 'end_date', coalesce(s.end_date, s.start_date),
    'date_text', case when s.start_date is null then nullif(sj->>'date', '') end,
    'venue', s.venue, 'city', s.city, 'state', s.state,
    'street_address', nullif(sj->>'street_address', ''),
    'website', case when sj->>'website' ~* '^https?://' then sj->>'website' end,
    'listed', coalesce(sj->>'listed', 'true') <> 'false',
    'removed', s.feed_removed_at is not null,
    'ended', coalesce(s.end_date, s.start_date) < current_date,
    'latitude', s.latitude, 'longitude', s.longitude,
    'listed_cards', v_count,
    'dealers', v_dealers,
    'show_page', '/show.html?id=' || s.id)) || public._show_feed(s.id);
end $$;
revoke all on function public.get_show_page(text) from public;
grant execute on function public.get_show_page(text) to anon, authenticated, service_role;

commit;

-- Check (run after):
--   select source, count(*) from public.shows group by 1;
--   select * from public.external_sync_runs order by started_at desc limit 5;
