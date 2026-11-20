#!/usr/bin/env bash
# Marketplace Phase 0: listing status functions. Needs Postgres 16. Synthetic data only.
#   ./marketplace-listings.test.sh      (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_marketplace}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f marketplace-listings.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true

# Two buyers reserve the same card at the same moment: exactly one wins.
psql -q -d "$DB" <<'SQL' >/dev/null
insert into auth.users values ('dddddddd-0000-0000-0000-000000000004'), ('eeeeeeee-0000-0000-0000-000000000005') on conflict do nothing;
insert into inventory (id, seller_id, card_title, price, status) values
  ('f0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'Race card', 200, 'Available');
SQL
psql -q -d "$DB" -c "set session authorization authenticator; set role authenticated; set request.jwt.claim.sub='bbbbbbbb-0000-0000-0000-000000000002'; select publish_listings(array['f0000000-0000-0000-0000-000000000001']::uuid[]);" >/dev/null
race() {
  psql -qtA -d "$DB" <<SQL
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub='$1';
begin;
select (reserve_listing('f0000000-0000-0000-0000-000000000001', '$1', 'buy_now'))->>'ok';
select pg_sleep(1.5);
commit;
SQL
}
race dddddddd-0000-0000-0000-000000000004 > /tmp/race1.$$ &
sleep 0.3
race eeeeeeee-0000-0000-0000-000000000005 > /tmp/race2.$$ &
wait
wins=$(cat /tmp/race1.$$ /tmp/race2.$$ | grep -c '^true$' || true)
held=$(psql -qtA -d "$DB" -c "select count(*) from listing_reservations where 'f0000000-0000-0000-0000-000000000001' = any(listing_ids)")
rm -f /tmp/race1.$$ /tmp/race2.$$
if [ "$wins" = 1 ] && [ "$held" = 1 ]; then echo 'PASS 24 two simultaneous reservations: exactly one succeeds'; else echo "FAIL 24 wins=$wins held=$held"; fi
