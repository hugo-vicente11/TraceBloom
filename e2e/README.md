# @tracebloom/e2e

End-to-end smoke test proving the core loop **SDK → collector → ClickHouse →
dashboard query** with a mocked provider (no API key).

```bash
# 1. bring up ClickHouse + Postgres + collector
pnpm stack:up

# 2. build the SDK the smoke test imports
pnpm build

# 3. run it (asserts the span lands in ClickHouse and in the dashboard query)
pnpm smoke
```

Honors `TRACEBLOOM_ENDPOINT`, `CLICKHOUSE_URL`, and `CLICKHOUSE_DATABASE`.
Exits non-zero on failure, so CI gates on it.
