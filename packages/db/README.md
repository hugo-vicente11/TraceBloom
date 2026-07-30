# @tracebloom/db

Postgres layer (Drizzle ORM) for TraceBloom's low-volume relational config.
High-volume telemetry lives in ClickHouse; this is for projects, config, and
(in a later milestone) eval definitions.

```bash
# Generate a migration from src/schema.ts after editing it
pnpm --filter @tracebloom/db db:generate

# Apply migrations to the database in DATABASE_URL (compose default shown)
DATABASE_URL=postgres://tracebloom:tracebloom@localhost:5432/tracebloom \
  pnpm --filter @tracebloom/db db:migrate
```

Schema lives in [src/schema.ts](src/schema.ts); generated SQL in [drizzle/](drizzle/).
