#!/usr/bin/env bash
# shows security. Needs Postgres 16. Synthetic data only.
#   ./shows-rls.test.sh      (run as a Postgres superuser, from tests/show-mode)
# Then re-runs the self-join, Show Directory and show status SQL tests with all the RLS migrations loaded.
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_shows_rls}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f shows-rls.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true

run () {  # $1 = test file, $2 = 1 to load the RLS migrations
  dropdb --if-exists "$DB" >/dev/null 2>&1 || true; createdb "$DB"
  psql -q -d "$DB" -f supabase-stub.sql >/dev/null
  psql -q -d "$DB" -c "alter table shows add column if not exists created_by uuid; create table if not exists admins (id uuid primary key);" >/dev/null
  psql -q -d "$DB" -f ../../supabase/migrations/20261027120000_seller_self_join.sql >/dev/null
  if [ "$1" = show-directory.test.sql ]; then
    psql -q -d "$DB" -f ../../supabase/migrations/20261028120000_show_directory.sql >/dev/null 2>&1
  fi
  if [ "$2" = 1 ]; then
    for m in 20261125120000_show_inventory_rls 20261126120000_show_sellers_rls 20261127120000_sellers_rls 20261128120000_shows_rls; do
      psql -q -d "$DB" -f ../../supabase/migrations/$m.sql >/dev/null
    done
  fi
  psql -q -d "$DB" -f "$1" 2>&1 | grep -cE 'PASS' || true
}
for t in self-join.test.sql show-directory.test.sql; do
  echo "$t — without RLS: $(run "$t" 0) PASS, with the four RLS migrations: $(run "$t" 1) PASS"
done
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
