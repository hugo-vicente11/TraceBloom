# Security Policy

TraceBloom is pre-1.0 software. This document describes how to report a
vulnerability, the security model of the public demo, and the known limitations
you should weigh before pointing it at real user data.

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue.

- Preferred: GitHub → the repository's **Security** tab → **Report a
  vulnerability** (private security advisory).
- We aim to acknowledge a report within a few days. Since this is a solo
  open-source project, please allow reasonable time to investigate and patch
  before any public disclosure.

Good things to include: affected component (collector, dashboard, an SDK, the
eval runner), a reproduction, and the impact you observed.

## Supported versions

Only the latest `main` is supported. There are no backports; fixes land on
`main` and the demo redeploys from it.

## Security model

The hosted demo is a deliberately **unauthenticated, read-only** instance. Its
safety comes from several independent layers rather than a single check
(see [DECISIONS.md](DECISIONS.md) D24–D27):

- **Read-only at the database layer.** The public dashboard connects with
  SELECT-only ClickHouse and Postgres credentials. A write fails in the database
  even if application code is bypassed. An application-level demo-mode guard
  refuses mutating actions as a first layer.
- **Minimal network surface.** Only the reverse proxy (Caddy) is exposed. The
  collector, ClickHouse and Postgres publish no host ports and are unreachable
  from the internet. Caddy terminates TLS (automatic HTTPS) and sets HSTS, a
  Content-Security-Policy, and the usual hardening headers.
- **Bounded "try it" sandbox.** The live-agent sandbox runs a **mock** model —
  no provider API keys exist in that process and cost is structurally zero. Runs
  are capped by span count, wall-clock watchdog, global concurrency, a daily
  budget, and a per-IP rate limit.
- **Rate limiting.** Every public read, SSE, and the try-it endpoint enforce a
  per-IP token bucket; the live SSE broker additionally caps total and per-trace
  subscribers to prevent connection-exhaustion fan-out.
- **Content is off by default.** Prompt/response capture is opt-in
  (`capture_content` / `TRACEBLOOM_CAPTURE_CONTENT`). When enabled it is stored
  only as span *events*, never as indexed attributes, and is served lazily.
- **Parameterized queries.** All ClickHouse and Postgres access uses bound
  parameters; user-supplied ids are validated (32/16-char lowercase hex) before
  use. User-controlled content is rendered as escaped React text only; there is
  no `dangerouslySetInnerHTML`.
- **Bounded retention.** ClickHouse tables carry TTLs (spans/events 30 days,
  eval results 90 days), so demo telemetry cannot accumulate without bound.
- **No secrets in the repo.** Only `.env.example` templates are tracked; the
  production stack generates random credentials on first deploy. No secret ever
  reaches the client bundle.

## Known limitations & residual risk

We do not claim the project is free of vulnerabilities. Known trade-offs:

- **The demo is intentionally shared and unauthenticated.** Anyone can read any
  trace/eval in the demo dataset by id. That is by design for a public,
  read-only showcase. Real multi-tenant auth and per-project isolation are on
  the roadmap and are required before hosting non-public data.
- **CSP still allows inline scripts.** The Content-Security-Policy blocks
  external script origins, framing, plugins, and base/form hijacking, but keeps
  `script-src 'unsafe-inline'` because Next.js injects inline bootstrap scripts.
  Output encoding (React) is the primary XSS defense; a nonce-based strict CSP
  is a planned hardening and needs browser testing.
- **In-process rate limiting.** Limits are per dashboard instance (the demo is a
  single instance behind one proxy). A horizontally-scaled deployment would need
  a shared store.
- **LLM-as-judge is susceptible to prompt injection.** Captured span content is
  interpolated into the judge prompt, so a traced application whose output
  contains judge-directed instructions can influence *its own* score and
  rationale. Impact is bounded: the verdict must parse as JSON and the score is
  clamped to the configured scale, so this affects eval quality rather than
  system integrity. Even so, do not treat judge scores as trustworthy for
  adversarial inputs. Deterministic evaluators are unaffected.
- **No third-party audit.** This has not been reviewed by an external security
  firm. Treat a professional review as a prerequisite before handling real user
  data.

## Dependency scanning

Dependencies are pinned via committed lockfiles (`pnpm-lock.yaml`, `Cargo.lock`,
`packages/sdk-py/uv.lock`). Automated scanning runs in CI and via Dependabot:

- **CI** (`.github/workflows/security.yml`): `pnpm audit` (production
  dependencies), `cargo audit`, and `pip-audit` on every push/PR and weekly.
- **Dependabot** (`.github/dependabot.yml`): weekly update PRs for npm, Cargo,
  uv/pip, and GitHub Actions.

To reproduce locally:

```bash
pnpm audit --prod                                   # JS/TS production deps
cargo audit                                         # Rust collector
cd packages/sdk-py && uv export --all-extras \
  --no-emit-project | uvx pip-audit -r /dev/stdin   # Python SDK
```
