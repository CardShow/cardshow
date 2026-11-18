#!/usr/bin/env bash
# Trades + Show Home golden-fixture test. Needs Postgres 16 and the TitoCollects import
# package (not in the repo: it's a real dealer's inventory and costs).
#   TITO_FIXTURE_DIR=/path/to/csvs ./trades.test.sh      (run from tests/show-mode)
set -euo pipefail
cd "$(dirname "$0")"
: "${TITO_FIXTURE_DIR:?Set TITO_FIXTURE_DIR to the folder with the three cardshow_*.csv files}"
DB=${DB:-cs_trades}
TMP=$(mktemp -d)
node ../../scripts/load_fixture_tito_nov7.js --dir "$TITO_FIXTURE_DIR" --owner 11111111-1111-1111-1111-111111111111 --handle tito > "$TMP/private.sql"
node ../../scripts/load_fixture_tito_nov7.js --dir "$TITO_FIXTURE_DIR" --owner 22222222-2222-2222-2222-222222222222 --handle tito2 --show show_t > "$TMP/cardshow.sql"
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
psql -q -d "$DB" -f supabase-stub.sql >/dev/null
psql -q -d "$DB" -v fixture_private="$TMP/private.sql" -v fixture_cardshow="$TMP/cardshow.sql" -f trades.test.sql 2>&1 \
  | grep -E 'PASS|FAIL|ERROR' || true
rm -rf "$TMP"
