# Self-hosting TraceBloom

The production stack runs on a single small VM with Docker Compose: Caddy
(the only service with published ports, automatic HTTPS) in front of the
dashboard, with the collector, ClickHouse, Postgres and the eval runner
reachable only inside the compose network. This is the same stack that serves
the public demo, minus nothing.

```
internet ── 80/443 ──> Caddy ──> dashboard (Next.js, read-only DB creds)
                                   │  OTLP (sandbox runs)
             internal only:        ▼
             collector (Rust) ──> ClickHouse    eval-runner ──> Postgres
```

## Requirements

- A VM with ~2 vCPU / 4 GB RAM (any provider, a €4–5/month instance is
  plenty), Ubuntu 22.04/24.04 or similar.
- Docker with the compose plugin (`docker compose version` ≥ 2.20).
- Optional but recommended: a DNS A record pointing at the VM (enables
  automatic HTTPS).

## Deploy in three commands

```bash
git clone https://github.com/hugo-vicente11/TraceBloom.git tracebloom && cd tracebloom
./infra/prod/deploy.sh up      # generates .env (random passwords), builds, migrates, starts
./infra/prod/deploy.sh seed    # loads the curated demo project (idempotent)
```

First `up` creates `infra/prod/.env` with random credentials and prints next
steps. To serve HTTPS, edit that file, set `DEMO_DOMAIN=demo.example.com` —
and run `./infra/prod/deploy.sh up` again; Caddy provisions the certificate
automatically. Without a domain the stack serves plain HTTP on port 80.

Verify the deployment end to end (same assertions CI runs):

```bash
./infra/prod/deploy.sh verify   # corpus present + regression detected
./infra/prod/smoke.sh           # public pages, read-only guarantees, bounded try-it
```

## Day-2 operations

| Task | Command |
|------|---------|
| Reset demo data to a clean seeded state | `./infra/prod/deploy.sh reset` |
| Nightly reset (recommended for a public demo) | `( crontab -l; echo '17 4 * * * /home/<you>/tracebloom/infra/prod/deploy.sh reset' ) \| crontab -` |
| Follow logs | `./infra/prod/deploy.sh logs [service]` |
| Update to latest main | `git pull && ./infra/prod/deploy.sh up` |
| Stop (volumes kept) | `./infra/prod/deploy.sh down` |

Data lives in named Docker volumes (`clickhouse-data`, `postgres-data`);
`down` never deletes them. Telemetry has ClickHouse TTLs (30 days for spans
and content, 90 for eval results) as a storage backstop.

## Configuration (`infra/prod/.env`)

| Variable | Meaning |
|----------|---------|
| `DEMO_DOMAIN` | Hostname for automatic HTTPS; empty = plain HTTP on :80 |
| `POSTGRES_PASSWORD` / `CLICKHOUSE_PASSWORD` | Internal read-write credentials (collector, runner, migrations) |
| `POSTGRES_RO_PASSWORD` / `CLICKHOUSE_RO_PASSWORD` | The dashboard's SELECT-only credentials |
| `OPENAI_API_KEY` | Optional, **server-side only** (eval runner): enables LLM-judge evals. Unset = judge evals skipped, deterministic evals unaffected |
| `TRACEBLOOM_IMAGE_PREFIX` / `TRACEBLOOM_IMAGE_TAG` | Switch from building on the VM to pulling prebuilt images (e.g. `ghcr.io/<owner>/tracebloom` + `latest`) |
| `TRACEBLOOM_SANDBOX_SCALE` | Pace multiplier for try-it runs (CI uses a small value; keep `1` for humans) |

Passwords are only read on first database boot; changing them later means
`ALTER USER`/`ALTER ROLE` by hand or recreating the volumes.

## The public-access model

What a visitor can do is bounded in three independent layers (see
DECISIONS.md D24–D27):

1. **Network**, only Caddy→dashboard is reachable; the OTLP ingest port and
   both databases are not exposed, so nobody can inject telemetry or touch
   storage.
2. **Credentials**, the dashboard's ClickHouse user is `readonly=2` with
   execution limits and its Postgres role has SELECT only; writes fail *in
   the database* even if application code misbehaves.
3. **Application**, `TRACEBLOOM_PUBLIC_DEMO=1` disables every mutating
   server action and renders config UIs read-only; the try-it sandbox is
   mock-LLM only, capped per IP, globally concurrency-capped and
   daily-budgeted, and namespaced (`demo-sandbox`) so reset wipes it.

Administration (seed/reset/eval config) happens over SSH with
`docker compose run`, there is intentionally no admin HTTP surface and no
account system in this milestone.

## Continuous deploy (optional)

`.github/workflows/deploy.yml` pushes images to GHCR and redeploys the VM on
every push to `main`, but only when you opt in:

1. Set the repository **variable** `DEMO_DEPLOY_ENABLED` to `true`.
2. Add repository **secrets** `DEMO_SSH_HOST`, `DEMO_SSH_USER` and
   `DEMO_SSH_KEY` (a private key authorized on the VM).
3. On the VM, set pull mode in `infra/prod/.env`
   (`TRACEBLOOM_IMAGE_PREFIX=ghcr.io/<owner>/tracebloom`,
   `TRACEBLOOM_IMAGE_TAG=latest`), and `docker login ghcr.io` once if the
   packages are private.

Without the variable, the workflow is skipped entirely.
