#!/usr/bin/env bash
# Seller MCP Phase 3 (20261215120000_mcp_seller_phase3.sql): set_prices, cards from photos, offers.
# Own database (loads the offers migrations). Needs Postgres 16.   ./mcp-seller-phase3.test.sh
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_mcp_seller3}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f mcp-seller-phase3.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true
[ -n "${KEEP_DB:-}" ] || dropdb "$DB"
