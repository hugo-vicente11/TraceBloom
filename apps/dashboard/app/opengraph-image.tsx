/**
 * Social share card (Open Graph + Twitter) for the landing page, generated at
 * build time with next/og: a real PNG, no external assets. Twitter inherits
 * this image via the metadata fallback (see layout.tsx). Kept in the trace
 * viewer's visual language: dark surface, category-colored waterfall bars.
 */

import { ImageResponse } from 'next/og';

export const alt = 'TraceBloom — observability + evals for LLM agents';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Trace-viewer category colors (matches app/icon.svg and the landing hero).
const BLUE = '#2a78d6';
const GREEN = '#10b981';
const AMBER = '#f59e0b';

function Bar({ width, color, indent = 0 }: { width: number; color: string; indent?: number }) {
  return (
    <div
      style={{
        width,
        height: 14,
        marginLeft: indent,
        borderRadius: 7,
        backgroundColor: color,
      }}
    />
  );
}

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 72,
        backgroundColor: '#020617',
        backgroundImage: 'radial-gradient(circle at 78% 18%, #0b2a24 0%, #020617 55%)',
        color: '#e2e8f0',
        fontFamily: 'sans-serif',
      }}
    >
      {/* Brand lockup: waterfall tile + wordmark */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 12,
            width: 112,
            height: 112,
            padding: 22,
            borderRadius: 26,
            backgroundColor: '#0f172a',
            border: '1px solid #1e293b',
          }}
        >
          <Bar width={60} color={BLUE} />
          <Bar width={50} color={GREEN} indent={14} />
          <Bar width={34} color={AMBER} indent={4} />
        </div>
        <div style={{ display: 'flex', fontSize: 62, fontWeight: 800, letterSpacing: -1 }}>
          <span style={{ color: '#f8fafc' }}>Trace</span>
          <span style={{ color: '#34d399' }}>Bloom</span>
        </div>
      </div>

      {/* Tagline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div
          style={{
            fontSize: 52,
            fontWeight: 700,
            lineHeight: 1.15,
            maxWidth: 940,
            color: '#f1f5f9',
          }}
        >
          See what your LLM agents actually do — and whether it&rsquo;s any good.
        </div>
        <div style={{ fontSize: 30, color: '#94a3b8', maxWidth: 900 }}>
          Open-source, OpenTelemetry-native tracing + evals for LLM agents.
        </div>
      </div>

      {/* Footer meta */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 26,
        }}
      >
        <div style={{ display: 'flex', color: '#64748b' }}>
          Rust collector · ClickHouse · live traces · eval regressions
        </div>
        <div style={{ display: 'flex', color: '#34d399', fontWeight: 600 }}>
          tracebloom.hugovicente.dev
        </div>
      </div>
    </div>,
    size,
  );
}
