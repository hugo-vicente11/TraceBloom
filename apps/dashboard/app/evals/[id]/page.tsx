import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isPublicDemo } from '../../../lib/demo-mode';
import {
  getEvalDefinition,
  listRegressions,
  recentScoredSpans,
  type ScoredSpan,
  scoreOverTime,
  type VariantRow,
  variantComparison,
} from '../../../lib/evals';
import { ConfigEditor, EnableToggle } from '../EvalControls';
import { ScoreChart } from '../ScoreChart';

export const dynamic = 'force-dynamic';

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function VariantTable({ variants, regressed }: { variants: VariantRow[]; regressed: Set<string> }) {
  if (variants.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">No scored variants yet.</p>;
  }
  return (
    <table className="w-full text-left text-sm">
      <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
        <tr>
          <th className="px-4 py-3 font-medium">Variant</th>
          <th className="px-4 py-3 font-medium">Mean score</th>
          <th className="px-4 py-3 text-right font-medium">Pass rate</th>
          <th className="px-4 py-3 text-right font-medium">Samples</th>
          <th className="px-4 py-3 font-medium">Flag</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {variants.map((v) => (
          <tr key={v.variant} className="hover:bg-slate-50">
            <td className="px-4 py-3 font-mono text-xs text-slate-700">{v.variant}</td>
            <td className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="w-10 tabular-nums text-slate-700">{v.meanScore.toFixed(2)}</span>
                <span className="h-2 w-28 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: pct(v.meanScore), backgroundColor: '#2a78d6' }}
                  />
                </span>
              </div>
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-slate-700">{pct(v.passRate)}</td>
            <td className="px-4 py-3 text-right tabular-nums text-slate-500">{v.sampleCount}</td>
            <td className="px-4 py-3">
              {regressed.has(v.variant) ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
                  ⚠ regression
                </span>
              ) : (
                <span className="text-xs text-slate-400">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ScoredSpanList({ spans }: { spans: ScoredSpan[] }) {
  if (spans.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">No scored spans yet.</p>;
  }
  return (
    <ul className="divide-y divide-slate-100">
      {spans.map((s) => (
        <li key={s.spanId} className="flex items-start gap-3 px-4 py-3">
          <span
            className={`mt-0.5 rounded-full px-2 py-0.5 text-xs font-medium ${
              s.errorType
                ? 'bg-amber-100 text-amber-700'
                : s.passed
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-rose-100 text-rose-700'
            }`}
          >
            {s.errorType ? s.errorType : s.label || (s.passed ? 'pass' : 'fail')}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="tabular-nums text-slate-700">score {s.score.toFixed(2)}</span>
              <span className="font-mono">{s.variant}</span>
              <Link
                href={`/traces/${s.traceId}?span=${s.spanId}`}
                className="font-mono hover:underline"
                title={s.traceId}
              >
                trace {s.traceId.slice(0, 12)}…
              </Link>
              <span>{s.spanStartTime}</span>
            </div>
            {s.explanation ? <p className="mt-1 text-sm text-slate-600">{s.explanation}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
        {title}
      </h2>
      <div className="p-4">{children}</div>
    </section>
  );
}

export default async function EvalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const readOnly = isPublicDemo();
  const { id } = await params;
  const def = await getEvalDefinition(id);
  if (!def) {
    notFound();
  }

  const [points, variants, regressions, spans] = await Promise.all([
    scoreOverTime(def.id, def.version),
    variantComparison(def.id, def.version),
    listRegressions(def.id),
    recentScoredSpans(def.id, def.version),
  ]);
  const regressed = new Set(regressions.map((r) => r.variant));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6">
        <Link href="/evals" className="text-sm text-slate-500 hover:underline">
          ← Evals
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{def.name}</h1>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
            {def.type}
          </span>
          <span className="tabular-nums text-sm text-slate-500">v{def.version}</span>
          {readOnly ? null : <EnableToggle id={def.id} enabled={def.enabled} />}
        </div>
      </header>

      <div className="space-y-6">
        <Card title="Mean score over time (last 30 days)">
          <ScoreChart points={points} />
        </Card>

        <Card title="Variant comparison (last 30 days)">
          <VariantTable variants={variants} regressed={regressed} />
        </Card>

        {regressions.length > 0 ? (
          <Card title={`Regressions (${regressions.length})`}>
            <ul className="space-y-2 text-sm">
              {regressions.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-2 text-slate-600">
                  <span className="font-mono text-xs text-rose-700">{r.variant}</span>
                  <span>·</span>
                  <span>{r.metric}</span>
                  <span className="tabular-nums">
                    {r.currentValue.toFixed(2)} vs {r.baselineVariant} {r.baselineValue.toFixed(2)}
                  </span>
                  <span className="tabular-nums text-rose-600">(Δ {r.delta.toFixed(2)})</span>
                  <span className="text-xs text-slate-400">
                    n={r.sampleCount} · {r.detectedAt.toISOString().slice(0, 10)}
                    {r.notified ? ' · notified' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card title="Scored spans">
          <ScoredSpanList spans={spans} />
        </Card>

        {readOnly ? (
          <Card title="Config (read-only in the public demo)">
            <pre className="overflow-x-auto rounded bg-slate-50 p-3 font-mono text-xs text-slate-700">
              {JSON.stringify(def.config, null, 2)}
            </pre>
          </Card>
        ) : (
          <Card title="Config (editing bumps the version)">
            <ConfigEditor id={def.id} config={JSON.stringify(def.config, null, 2)} />
          </Card>
        )}
      </div>
    </main>
  );
}
