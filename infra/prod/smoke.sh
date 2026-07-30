#!/usr/bin/env bash
# Guardrail smoke test for a running production stack (CI and local).
#
# Asserts, against http://localhost (Caddy):
#   1. the public pages answer (landing, traces, evals, status);
#   2. the public path provably cannot write: the dashboard's ClickHouse and
#      Postgres credentials are rejected on INSERT at the DATABASE layer, and
#      the evals UI renders read-only;
#   3. a try-it run is admitted, stays within its span bound, contains no
#      foreign (Next.js) spans, and repeated requests hit the per-IP limit.
#
# Requires: the stack up (deploy.sh up), seeded (deploy.sh seed), and the
# stack's .env next to this script. Exits non-zero on the first failure.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${SMOKE_BASE_URL:-http://localhost}"
# shellcheck disable=SC1091
source "${HERE}/.env"

CH=(docker exec tracebloom-prod-clickhouse clickhouse-client)
CH_RO=("${CH[@]}" --user tracebloom_ro --password "${CLICKHOUSE_RO_PASSWORD}")
CH_ADMIN=("${CH[@]}" --password "${CLICKHOUSE_PASSWORD}")
PSQL_RO=(docker exec tracebloom-prod-postgres psql
  "postgres://tracebloom_ro:${POSTGRES_RO_PASSWORD}@localhost/tracebloom" -tA)

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1" >&2; exit 1; }

http_code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }

echo "==> Public pages"
[[ "$(http_code "${BASE_URL}/")" == 200 ]] || fail "landing not 200"
pass "landing answers"
[[ "$(http_code "${BASE_URL}/traces")" == 200 ]] || fail "/traces not 200"
curl -s "${BASE_URL}/traces?hours=168" | grep -q 'href="/traces/' || fail "trace list shows no traces"
pass "trace list shows seeded traces"
curl -s "${BASE_URL}/evals" | grep -q 'read-only' || fail "evals page is not in read-only demo mode"
pass "evals page renders read-only"
[[ "$(http_code "${BASE_URL}/api/status")" == 200 ]] || fail "/api/status not 200"
pass "status endpoint healthy"

echo "==> Read-only guarantees (database layer)"
"${CH_RO[@]}" --query "SELECT count() FROM tracebloom.spans" >/dev/null \
  || fail "read-only ClickHouse user cannot SELECT"
if "${CH_RO[@]}" --query "INSERT INTO tracebloom.spans (trace_id, span_id) VALUES ('x','y')" 2>/dev/null; then
  fail "read-only ClickHouse user was able to INSERT"
fi
pass "ClickHouse: dashboard credentials are SELECT-only"
if "${PSQL_RO[@]}" -c "INSERT INTO projects (slug, name) VALUES ('smoke','smoke')" >/dev/null 2>&1; then
  fail "read-only Postgres role was able to INSERT"
fi
pass "Postgres: dashboard role is SELECT-only"

echo "==> Try-it sandbox"
FIRST=$(curl -s -X POST "${BASE_URL}/api/try-it")
TRACE_ID=$(echo "${FIRST}" | sed -n 's/.*"traceId":"\([0-9a-f]\{32\}\)".*/\1/p')
[[ -n "${TRACE_ID}" ]] || fail "try-it did not return a trace id: ${FIRST}"
pass "run admitted: ${TRACE_ID}"

# Exhaust the per-IP bucket (capacity 3): two more are admitted or hit the
# concurrency cap; the fourth must be the per-IP 429.
codes=()
for _ in 1 2 3; do
  codes+=("$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/api/try-it")")
done
[[ "${codes[2]}" == 429 ]] || fail "4th rapid try-it was ${codes[2]}, expected 429 (got: ${codes[*]})"
pass "per-IP rate limit enforced (${codes[*]})"

echo "    waiting for the run to finish…"
DEADLINE=$(( $(date +%s) + 90 ))
while :; do
  COUNT=$("${CH_ADMIN[@]}" --query \
    "SELECT count() FROM tracebloom.spans WHERE trace_id = '${TRACE_ID}'")
  ROOTS=$("${CH_ADMIN[@]}" --query \
    "SELECT count() FROM tracebloom.spans WHERE trace_id = '${TRACE_ID}' AND parent_span_id = ''")
  if [[ "${ROOTS}" -ge 1 ]]; then
    break
  fi
  [[ $(date +%s) -lt ${DEADLINE} ]] || fail "sandbox run did not complete in 90s (${COUNT} spans)"
  sleep 2
done
[[ "${COUNT}" -le 12 ]] || fail "sandbox run produced ${COUNT} spans (> 12 bound)"
pass "run bounded: ${COUNT} spans, root landed"

FOREIGN=$("${CH_ADMIN[@]}" --query "
  SELECT count() FROM tracebloom.spans
  WHERE trace_id = '${TRACE_ID}'
    AND operation_name NOT IN ('chat', 'execute_tool', 'invoke_agent', 'execute_task')")
[[ "${FOREIGN}" == 0 ]] || fail "sandbox trace contains ${FOREIGN} foreign (non-gen_ai) spans"
pass "no foreign spans leaked into the sandbox trace"

SERVICE=$("${CH_ADMIN[@]}" --query "
  SELECT DISTINCT service_name FROM tracebloom.spans WHERE trace_id = '${TRACE_ID}'")
[[ "${SERVICE}" == "demo-sandbox" ]] || fail "sandbox trace has service '${SERVICE}'"
pass "sandbox namespace isolation (service_name=demo-sandbox)"

echo "==> All smoke checks passed."
