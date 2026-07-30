#!/usr/bin/env bash
# Apply ClickHouse migrations over the HTTP interface.
#
# Every migration is a single, idempotent statement (CREATE ... IF NOT EXISTS),
# so this script is safe to run repeatedly. The same .sql files are mounted into
# the ClickHouse container's docker-entrypoint-initdb.d for fresh local boots, so
# there is exactly one source of truth for the schema.
#
# Usage:
#   CLICKHOUSE_URL=http://localhost:8123 infra/clickhouse/migrate.sh
set -euo pipefail

CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://localhost:8123}"
MIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/migrations" && pwd)"

echo "Applying ClickHouse migrations from ${MIG_DIR} -> ${CLICKHOUSE_URL}"
shopt -s nullglob
for f in "${MIG_DIR}"/*.sql; do
  echo "  -> $(basename "$f")"
  curl -sS --fail-with-body --data-binary "@${f}" "${CLICKHOUSE_URL}/?default_format=JSONEachRow" \
    || { echo "migration failed: ${f}" >&2; exit 1; }
done
echo "ClickHouse migrations applied."
