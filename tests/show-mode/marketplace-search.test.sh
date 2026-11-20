#!/usr/bin/env bash
# Marketplace Phase 1: pricing service, search, listing pages, saved searches. Needs Postgres 16.
# Synthetic data only.   ./marketplace-search.test.sh   (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_marketplace_search}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f marketplace-search.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
dropdb "$DB"
