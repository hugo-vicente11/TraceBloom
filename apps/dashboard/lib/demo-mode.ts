/**
 * Public-demo mode (TRACEBLOOM_PUBLIC_DEMO=1): the dashboard serves read-only
 * telemetry to anonymous visitors plus the bounded try-it sandbox.
 *
 * This application-layer guard is the FIRST of three read-only layers, not the
 * only one: the prod stack also runs the dashboard with SELECT-only database
 * credentials (a write would fail in Postgres/ClickHouse even if this guard
 * were bypassed) and publishes no other service (DECISIONS.md D25). Server
 * actions call `requireMutableConfig()` before touching config.
 */

export function isPublicDemo(): boolean {
  const value = process.env.TRACEBLOOM_PUBLIC_DEMO;
  return value === '1' || value === 'true';
}

export class DemoModeError extends Error {
  constructor() {
    super('This is a read-only public demo — configuration cannot be changed here.');
    this.name = 'DemoModeError';
  }
}

/** Throw when running as the public demo; no-op otherwise. */
export function requireMutableConfig(): void {
  if (isPublicDemo()) {
    throw new DemoModeError();
  }
}
