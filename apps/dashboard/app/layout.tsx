import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * Canonical public origin. Defaults to the hosted demo; a self-hoster can point
 * link previews and canonical URLs at their own domain by setting
 * NEXT_PUBLIC_SITE_URL at build time (threaded through the Dockerfile build arg).
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://tracebloom.hugovicente.dev';

const TITLE = 'TraceBloom — observability + evals for LLM agents';
const DESCRIPTION =
  'Open-source, OpenTelemetry-native observability and evaluation for LLM agents: waterfall traces of every step, live streaming runs, and eval scores that catch prompt regressions.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: 'TraceBloom',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'TraceBloom',
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    // og:image is supplied automatically by app/opengraph-image.tsx.
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    // twitter:image falls back to the Open Graph image above.
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#0f172a',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
