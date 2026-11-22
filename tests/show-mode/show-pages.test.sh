#!/usr/bin/env bash
# Show pages, pickup show and shipping price (20261206120000). Needs Postgres 16.
# Synthetic data only.   ./buyer-site.test.sh   (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_show_pages}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f show-pages.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
[ -n "${KEEP:-}" ] || dropdb "$DB"
