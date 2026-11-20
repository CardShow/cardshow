#!/usr/bin/env bash
# Marketplace photo requirement. Needs Postgres 16. Synthetic data only.
#   ./marketplace-photos.test.sh      (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_marketplace_photos}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f marketplace-photos.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
dropdb "$DB"
