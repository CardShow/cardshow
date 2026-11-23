#!/usr/bin/env bash
# Bundle offers (20261209120000). Needs Postgres 16.
# Synthetic data only.   ./marketplace-bundle-offers.test.sh   (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_bundle}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f marketplace-bundle-offers.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
[ -n "${KEEP:-}" ] || dropdb "$DB"
