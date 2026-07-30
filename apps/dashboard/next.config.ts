import { join } from 'node:path';
import type { NextConfig } from 'next';

// Defense-in-depth security headers applied by the app itself, so they hold even
// when the dashboard is run without the prod Caddy edge (which additionally sets
// HSTS + a Content-Security-Policy: see infra/prod/Caddyfile). CSP is left to
// the edge here so `next dev` HMR (inline eval) is not broken and there is a
// single authoritative CSP.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Drop the X-Powered-By: Next.js header: no need to advertise the framework.
  poweredByHeader: false,
  // @clickhouse/client is a server-only Node dependency; keep it external so it
  // is never bundled into client output.
  serverExternalPackages: ['@clickhouse/client'],
  // The app lives in a pnpm monorepo: trace from the repo root so standalone
  // output resolves workspace dependencies outside apps/dashboard.
  outputFileTracingRoot: join(import.meta.dirname, '../..'),
  // Standalone output only for the production image build; `next dev` and a
  // plain `next start` keep their default behavior.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
};

export default nextConfig;
