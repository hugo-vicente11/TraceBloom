/**
 * The landing page: the product front door. Purely server-rendered except
 * the try-it button and the status dot. The hero "waterfall" is a hand-built
 * CSS illustration in the trace viewer's exact visual language (same category
 * colors, chips and badges), not a screenshot: captioned as such.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusDot } from './StatusDot';
import { TryItButton } from './TryItButton';

export const metadata: Metadata = {
  title: 'TraceBloom — observability + evals for LLM agents',
  description:
    'Open-source, OTel-native tracing and evaluation for LLM agents: waterfall traces of every step, live streaming runs, and eval scores that catch prompt regressions.',
};

const GITHUB_URL = 'https://github.com/hugo-vicente11/TraceBloom';

// Trace viewer category colors (app/traces/[traceId]/theme.tsx).
const C = { llm: '#2a78d6', tool: '#1baf7a', agent: '#eda100', error: '#d03b3b' };

/** Wordmark glyph — the waterfall motif shared with the favicon (app/icon.svg). */
function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="7" fill="#0f172a" />
      <rect x="8" y="9" width="14" height="3.6" rx="1.8" fill="#2a78d6" />
      <rect x="11" y="14.2" width="12" height="3.6" rx="1.8" fill="#10b981" />
      <rect x="8.5" y="19.4" width="8" height="3.6" rx="1.8" fill="#f59e0b" />
    </svg>
  );
}

function Bar({
  left,
  width,
  color,
  pulse = false,
}: {
  left: number;
  width: number;
  color: string;
  pulse?: boolean;
}) {
  return (
    <div className="relative h-4 flex-1">
      <div
        className={`absolute top-0.5 h-3 rounded-sm ${pulse ? 'animate-pulse' : ''}`}
        style={{ left: `${left}%`, width: `${width}%`, backgroundColor: color }}
      />
    </div>
  );
}

function Row({
  depth,
  color,
  name,
  bar,
  chip,
}: {
  depth: number;
  color: string;
  name: string;
  bar: ReactNode;
  chip?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <div
        className="flex w-52 shrink-0 items-center gap-1.5 font-mono text-[11px] text-slate-600"
        style={{ paddingLeft: depth * 14 }}
      >
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-sm"
          style={{ backgroundColor: color }}
        />
        <span className="truncate">{name}</span>
      </div>
      {bar}
      <div className="w-40 shrink-0 text-right">{chip}</div>
    </div>
  );
}

function Chip({ pass, label }: { pass: boolean; label: string }) {
  return (
    <span
      className={`inline-block rounded-full px-1.5 py-px font-mono text-[10px] font-medium ${
        pass ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
      }`}
    >
      {label} {pass ? '✓' : '✗'}
    </span>
  );
}

function HeroWaterfall() {
  return (
    <figure className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-slate-500">trace 9f31c2…</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
            LIVE
          </span>
        </div>
        <span className="font-mono text-xs tabular-nums text-slate-400">
          9 spans · 424 tok · $0.0031
        </span>
      </div>
      <div className="space-y-px overflow-x-auto px-4 py-3">
        <Row
          depth={0}
          color={C.agent}
          name="invoke_agent researcher"
          bar={<Bar left={0} width={100} color={C.agent} />}
        />
        <Row
          depth={1}
          color={C.llm}
          name="chat gpt-4o"
          bar={<Bar left={2} width={14} color={C.llm} />}
        />
        <Row
          depth={1}
          color={C.error}
          name="execute_tool web.search"
          bar={<Bar left={18} width={10} color={C.error} />}
          chip={<span className="font-mono text-[10px] text-rose-600">429 rate limited</span>}
        />
        <Row
          depth={1}
          color={C.tool}
          name="execute_tool web.search"
          bar={<Bar left={30} width={12} color={C.tool} />}
          chip={
            <span className="rounded bg-slate-100 px-1 py-px font-mono text-[10px] text-slate-600">
              ↻ ×2
            </span>
          }
        />
        <Row
          depth={1}
          color={C.tool}
          name="execute_tool web.fetch"
          bar={<Bar left={44} width={17} color={C.tool} />}
        />
        <Row
          depth={1}
          color={C.tool}
          name="execute_tool web.fetch"
          bar={<Bar left={46} width={23} color={C.tool} />}
        />
        <Row
          depth={1}
          color={C.llm}
          name="chat gpt-4o"
          bar={<Bar left={71} width={16} color={C.llm} pulse />}
          chip={<Chip pass={false} label="no-refusal" />}
        />
        <Row
          depth={1}
          color={C.agent}
          name="invoke_agent summarizer"
          bar={<Bar left={88} width={12} color={C.agent} />}
        />
        <Row
          depth={2}
          color={C.llm}
          name="chat gpt-4o-mini"
          bar={<Bar left={89} width={10} color={C.llm} />}
          chip={<Chip pass label="quality 0.86" />}
        />
      </div>
      <figcaption className="border-t border-slate-100 px-4 py-2 text-center text-[11px] text-slate-400">
        Illustration of the live trace viewer — open the demo for the real thing.
      </figcaption>
    </figure>
  );
}

function ValueProp({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="font-semibold text-slate-800">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{children}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-800 font-mono text-sm text-white">
        {n}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold text-slate-800">{title}</h3>
        <div className="mt-1.5 text-sm text-slate-500">{children}</div>
      </div>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">
      {children}
    </pre>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Logo className="h-7 w-7" />
          <span>
            Trace<span className="text-emerald-600">Bloom</span>
          </span>
        </Link>
        <div className="flex items-center gap-5 text-sm font-medium text-slate-600">
          <Link href="/traces" className="hover:text-slate-900 hover:underline">
            Live demo
          </Link>
          <Link href="/evals" className="hover:text-slate-900 hover:underline">
            Evals
          </Link>
          <a href={GITHUB_URL} className="hover:text-slate-900 hover:underline">
            GitHub
          </a>
          <StatusDot />
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-6">
        <section className="grid items-center gap-10 py-14 lg:grid-cols-2">
          <div>
            <h1 className="text-4xl font-bold leading-tight tracking-tight text-slate-900">
              See what your LLM agents actually do —{' '}
              <span className="text-emerald-600">and whether it&rsquo;s any good.</span>
            </h1>
            <p className="mt-4 max-w-xl text-lg leading-relaxed text-slate-600">
              TraceBloom is an open-source <strong>observability + evaluation</strong> layer for LLM
              agents. Every call, tool step and retry as a live waterfall; every output scored by
              evals that catch quality regressions before your users do.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link
                href="/traces"
                className="rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-slate-700"
              >
                Open live demo
              </Link>
              <TryItButton size="lg" />
              <a
                href={GITHUB_URL}
                className="rounded-lg border border-slate-300 bg-white px-5 py-2.5 font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
              >
                GitHub
              </a>
            </div>
            <p className="mt-3 text-sm text-slate-500">
              No signup. The demo is the real dashboard on real telemetry; &ldquo;run a live
              agent&rdquo; streams a fresh sandboxed run in front of you.
            </p>
          </div>
          <HeroWaterfall />
        </section>

        <section className="grid gap-4 pb-14 sm:grid-cols-3">
          <ValueProp title="Agent traces, reconstructed">
            One line of SDK setup turns agent runs into collapsible tree + waterfall traces — every
            LLM call with tokens and cost, every tool call, retry, failure and sub-agent.
          </ValueProp>
          <ValueProp title="Watch runs live">
            Open a trace while the agent is still running: spans stream in over SSE, in-progress
            bars grow, a failed tool flips red and its retry lands next to it.
          </ValueProp>
          <ValueProp title="Evals that catch regressions">
            Deterministic rules and LLM-as-judge score real traffic out-of-band. Variants are
            compared automatically — when a prompt change drops quality, it gets flagged.
          </ValueProp>
        </section>

        <section className="border-t border-slate-200 py-14">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">How it works</h2>
          <div className="mt-8 grid gap-10 lg:grid-cols-3">
            <Step n={1} title="Instrument in one line">
              Wrap your client — or point any OpenTelemetry SDK at the collector. Spans follow the
              OTel GenAI conventions.
              <CodeBlock>
                {`init({ serviceName: 'my-agent' });
const openai = instrumentOpenAI(new OpenAI());`}
              </CodeBlock>
            </Step>
            <Step n={2} title="Traces flow in, live">
              The Rust collector writes OTLP to ClickHouse; the dashboard reconstructs agent runs
              and streams still-running traces to the viewer.
              <CodeBlock>
                {`await withAgentSpan('researcher', async () => {
  await withToolSpan('web.search', search);
});`}
              </CodeBlock>
            </Step>
            <Step n={3} title="Evals score everything">
              Define checks once; the runner scores landed spans, compares prompt variants and
              alerts on regressions.
              <CodeBlock>
                {`{ "rules": [
  { "kind": "not_contains", "text": "I cannot" }
] }`}
              </CodeBlock>
            </Step>
          </div>
        </section>

        <section className="flex flex-wrap items-center justify-between gap-6 border-t border-slate-200 py-10">
          <div className="text-sm text-slate-500">
            <p className="font-medium text-slate-700">Built on standards, built to self-host.</p>
            <p className="mt-1 max-w-2xl">
              OpenTelemetry GenAI semantic conventions · canonical OTLP wire format · Rust collector
              · ClickHouse + Postgres · one-command Docker deploy · Apache-2.0.
            </p>
          </div>
          <a
            href={`${GITHUB_URL}#quickstart-from-clone-to-a-visible-trace`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Quickstart →
          </a>
        </section>
      </main>

      <footer className="border-t border-slate-200 py-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 text-sm text-slate-500">
          <span className="flex items-center gap-2">
            <Logo className="h-5 w-5" />
            TraceBloom · Apache-2.0
          </span>
          <div className="flex items-center gap-4">
            <Link href="/traces" className="hover:text-slate-600 hover:underline">
              Live demo
            </Link>
            <a href={GITHUB_URL} className="hover:text-slate-600 hover:underline">
              GitHub
            </a>
            <StatusDot />
          </div>
        </div>
      </footer>
    </div>
  );
}
