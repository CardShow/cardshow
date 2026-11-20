-- Show geocoding (Marketplace Phase 1: "cards at shows within X miles"). US Census data only.
-- Run after 20261128120000_shows_rls.sql and 20261130120000_marketplace_pricing_search.sql. Re-runnable.
--
--   shows.street_address / postal_code   entered in the Show Directory (optional)
--   shows.geo_source                     'census_address' (Census Geocoder matched the street address),
--                                        'census_place' (city center from the Census Gazetteer),
--                                        'manual' (set by the platform owner), 'not_found', or null = not tried yet
--   shows.geo_query / geo_error / geocoded_at
--
-- netlify/functions/geocode-shows.js fills these hourly, and right after a Directory save.
-- Coordinates are written only by the service role or the platform owner (trigger shows_geo_a_guard).
-- Changing the street address, ZIP, city or state clears them so the show is located again (shows_geo_b_reset).

begin;

alter table public.shows
  add column if not exists latitude numeric,
  add column if not exists longitude numeric,
  add column if not exists street_address text,
  add column if not exists postal_code text,
  add column if not exists geo_source text,
  add column if not exists geo_query text,
  add column if not exists geo_error text,
  add column if not exists geocoded_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shows_geo_source_check') then
    alter table public.shows add constraint shows_geo_source_check
      check (geo_source is null or geo_source in ('census_address','census_place','manual','not_found'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shows_geo_range_check') then
    alter table public.shows add constraint shows_geo_range_check
      check ((latitude is null or latitude between -90 and 90) and (longitude is null or longitude between -180 and 180));
  end if;
end $$;

create index if not exists shows_geo_pending_idx on public.shows (start_date) where geo_source is null;

-- (a) Only the service role, database functions or the platform owner set coordinates.
create or replace function public._shows_geo_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;   -- service role, definer functions
  if to_regprocedure('public._shows_is_platform_admin()') is not null and public._shows_is_platform_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.latitude is not null or new.longitude is not null or new.geo_source is not null or new.geocoded_at is not null then
      raise exception 'geo_locked' using errcode = '42501', hint = 'Show locations are set by CardShow.';
    end if;
  elsif new.latitude is distinct from old.latitude or new.longitude is distinct from old.longitude
     or new.geo_source is distinct from old.geo_source or new.geocoded_at is distinct from old.geocoded_at
     or new.geo_query is distinct from old.geo_query or new.geo_error is distinct from old.geo_error then
    raise exception 'geo_locked' using errcode = '42501', hint = 'Show locations are set by CardShow.';
  end if;
  return new;
end $$;

-- (b) A new address means a new location: clear it unless this same update sets coordinates.
create or replace function public._shows_geo_reset() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.street_address is distinct from old.street_address or new.postal_code is distinct from old.postal_code
      or new.city is distinct from old.city or new.state is distinct from old.state)
     and new.latitude is not distinct from old.latitude and new.longitude is not distinct from old.longitude then
    new.latitude := null; new.longitude := null; new.geo_source := null;
    new.geo_query := null; new.geo_error := null; new.geocoded_at := null;
  end if;
  return new;
end $$;

drop trigger if exists shows_geo_a_guard on public.shows;
create trigger shows_geo_a_guard before insert or update on public.shows
  for each row execute function public._shows_geo_guard();
drop trigger if exists shows_geo_b_reset on public.shows;
create trigger shows_geo_b_reset before update on public.shows
  for each row execute function public._shows_geo_reset();

commit;
