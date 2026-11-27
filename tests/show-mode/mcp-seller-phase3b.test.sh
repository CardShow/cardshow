#!/usr/bin/env bash
# Seller MCP Phase 3b (20261216120000_mcp_seller_phase3b.sql): add_cards from details, photo links.
# Builds on the Phase 3 test data. Needs Postgres 16.   ./mcp-seller-phase3b.test.sh
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_mcp_seller3b}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f mcp-seller-phase3.test.sql >/dev/null 2>&1
psql -q -d "$DB" -f mcp-seller-phase3b.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
[ -n "${KEEP_DB:-}" ] || dropdb "$DB"
