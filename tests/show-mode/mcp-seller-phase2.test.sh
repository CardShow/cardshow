#!/usr/bin/env bash
# Seller MCP Phase 2 (20261214120000_mcp_seller_phase2.sql): previews, confirm tokens, idempotent record_sale.
# Builds on the Phase 1 test data. Needs Postgres 16.   ./mcp-seller-phase2.test.sh
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_mcp_seller2}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f mcp-seller.test.sql >/dev/null 2>&1
psql -q -d "$DB" -f mcp-seller-phase2.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
[ -n "${KEEP_DB:-}" ] || dropdb "$DB"
