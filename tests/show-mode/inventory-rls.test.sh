#!/usr/bin/env bash
# Inventory security: own-row writes, GTCR trust fields. Needs Postgres 16. Synthetic data only.
#   ./inventory-rls.test.sh      (run as a Postgres superuser, from tests/show-mode)
# Then re-runs the trade, import, Show Mode sales and marketplace suites with this migration
# loaded, since those write inventory as the signed-in seller.
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_inv_rls}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f inventory-rls.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true

RLS='\\i ../../supabase/migrations/20261124120000_inventory_rls.sql'
run_with_rls () {  # $1 = suite name, $2 = sed expression that inserts the RLS migration
  local tmp; tmp=$(mktemp ./.rls-XXXX.sql)
  sed "$2" "$1.test.sql" > "$tmp"
  dropdb --if-exists "$DB" >/dev/null 2>&1 || true; createdb "$DB"
  psql -q -d "$DB" -f supabase-stub.sql >/dev/null
  local out; out=$(psql -q -d "$DB" -f "$tmp" 2>&1 || true); rm -f "$tmp"
  echo "with inventory RLS — $1: $(grep -cE '^ ?PASS' <<<"$out") PASS, $(grep -cE '^ ?FAIL' <<<"$out") FAIL"
  grep -E '^ ?FAIL' <<<"$out" || true
}
run_with_rls trade-logging "s#^\\\\i ../../supabase/migrations/20261121120000_trade_logging.sql\$#&\n$RLS#"
run_with_rls show-log-import "s#^\\\\i ../../supabase/migrations/20261120120000_show_log_import.sql\$#&\n$RLS#"
run_with_rls marketplace-listings "s#^\\\\i ../../supabase/migrations/20261122120000_marketplace_listings.sql\$#&\n$RLS#"
run_with_rls cost-tracking "s#^\\\\i ../../supabase/migrations/20261114120000_cost_tracking.sql\$#&\n$RLS#"
run_with_rls snap-sell "s#^\\\\i ../../supabase/migrations/20261115120000_snap_sell.sql\$#&\n$RLS#"
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
