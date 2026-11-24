#!/usr/bin/env bash
# Dealer offer rules (20261211120000). Needs Postgres 16.
# Synthetic data only.   ./marketplace-offer-rules.test.sh   (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_offer_rules}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f marketplace-offer-rules.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
[ -n "${KEEP:-}" ] || dropdb "$DB"
