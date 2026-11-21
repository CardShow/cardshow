#!/usr/bin/env bash
# Pricing admin queue, access fix, resolve actions. Needs Postgres 16.
# Synthetic data only.   ./pricing-admin.test.sh   (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_pricing_admin}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f pricing-admin.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
dropdb "$DB"
