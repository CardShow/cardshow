#!/usr/bin/env bash
# The Card Shop Finder events sync (20261210120000). Needs Postgres 16.
# Synthetic data only.   ./csf-events.test.sh   (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_csf_events}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f csf-events.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
[ -n "${KEEP:-}" ] || dropdb "$DB"
