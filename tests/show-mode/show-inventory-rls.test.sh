#!/usr/bin/env bash
# show_inventory security. Needs Postgres 16. Synthetic data only.
#   ./show-inventory-rls.test.sh      (run as a Postgres superuser, from tests/show-mode)
# Then re-runs the suites that write show_inventory as the seller (trades) or through definer
# functions (Show Mode sales) with both RLS migrations loaded.
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-cs_si_rls}
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -f show-inventory-rls.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR' || true

RLS='\\i ../../supabase/migrations/20261124120000_inventory_rls.sql\n\\i ../../supabase/migrations/20261125120000_show_inventory_rls.sql'
run_with_rls () {  # $1 = suite name, $2 = sed expression that inserts the RLS migrations
  local tmp; tmp=$(mktemp ./.rls-XXXX.sql)
  sed "$2" "$1.test.sql" > "$tmp"
  dropdb --if-exists "$DB" >/dev/null 2>&1 || true; createdb "$DB"
  psql -q -d "$DB" -f supabase-stub.sql >/dev/null
  psql -q -d "$DB" -c "alter table shows add column if not exists created_by uuid; alter table show_inventory enable row level security; create policy \"Allow all\" on show_inventory for all using (true) with check (true);" >/dev/null
  local out; out=$(psql -q -d "$DB" -f "$tmp" 2>&1 || true); rm -f "$tmp"
  echo "with both RLS migrations — $1: $(grep -cE '^ ?PASS' <<<"$out") PASS, $(grep -cE '^ ?FAIL' <<<"$out") FAIL"
  grep -E '^ ?FAIL' <<<"$out" || true
}
# The trade suite's dealer A is a seller in its show, as a real dealer logging a trade would be.
run_with_rls trade-logging "s#^\\\\i ../../supabase/migrations/20261121120000_trade_logging.sql\$#&\n$RLS#;s#^insert into shows (id, name, start_date.*\$#&\ninsert into show_sellers (show_id, seller_id) values ('show_t', 'aaaaaaaa-0000-0000-0000-000000000001');#"
run_with_rls show-log-import "s#^\\\\i ../../supabase/migrations/20261120120000_show_log_import.sql\$#&\n$RLS#"
run_with_rls marketplace-listings "s#^\\\\i ../../supabase/migrations/20261122120000_marketplace_listings.sql\$#&\n$RLS#"
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
