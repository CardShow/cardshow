#!/usr/bin/env bash
# Seller MCP Phase 1 (20261213120000_mcp_seller_phase1.sql). Needs Postgres 16. Synthetic data only.
#   ./mcp-seller.test.sh   (run as a Postgres superuser, from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_mcp_seller}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f mcp-seller.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
[ -n "${KEEP_DB:-}" ] || dropdb "$DB"
