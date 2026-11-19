#!/usr/bin/env bash
# Show log import (Trades + Show Home Phase 3). Needs Postgres 16. Synthetic data only.
#   ./show-log-import.test.sh      (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_import}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f show-log-import.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
