#!/usr/bin/env bash
# Buyer site support: public listing photos, dealer contact. Needs Postgres 16.
# Synthetic data only.   ./buyer-site.test.sh   (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_buyer_site}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f buyer-site.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
dropdb "$DB"
