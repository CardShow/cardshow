#!/usr/bin/env bash
# Show geocoding columns, guard and reset. Needs Postgres 16. Synthetic data only.
#   ./show-geocoding.test.sh      (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_show_geo}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f show-geocoding.test.sql 2>&1 | grep -E 'PASS|FAIL' || true
dropdb "$DB"
