import Link from 'next/link';
import { isPublicDemo } from '../../lib/demo-mode';
import { type EvalDefinition, listEvalDefinitions } from '../../lib/evals';
import { CreateEvalForm, EnableToggle } from './EvalControls';

export const dynamic = 'force-dynamic';

function selectorSummary(def: EvalDefinition): string {
  const s = def.selector;
  const parts: string[] = [];
  if (s.operations?.length) {
    parts.push(`ops=${s.operations.join('/')}`);
  }
  if (s.models?.length) {
    parts.push(`models=${s.models.join('/')}`);
  }
  if (s.serviceNames?.length) {
    parts.push(`svc=${s.serviceNames.join('/')}`);
  }
  parts.push(`sample=${Math.round(s.samplingRate * 100)}%`);
  return parts.join(' · ');
}

function ReadOnlyStatus({ enabled }: { enabled: boolean }) {
  const classes = enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>
      {enabled ? 'enabled' : 'disabled'}
    </span>
  );
}

function EvalTable({ evals, readOnly }: { evals: EvalDefinition[]; readOnly: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3 font-medium">Eval</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 font-medium">Selector</th>
            <th className="px-4 py-3 text-right font-medium">Version</th>
            <th className="px-4 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {evals.map((def) => (
            <tr key={def.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 font-medium text-slate-800">
                <Link href={`/evals/${def.id}`} className="hover:underline">
                  {def.name}
                </Link>
              </td>
              <td className="px-4 py-3">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
                  {def.type}
                </span>
              </td>
              <td className="px-4 py-3 text-xs text-slate-500">{selectorSummary(def)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-slate-600">v{def.version}</td>
              <td className="px-4 py-3">
                {readOnly ? (
                  <ReadOnlyStatus enabled={def.enabled} />
                ) : (
                  <EnableToggle id={def.id} enabled={def.enabled} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function EvalsPage() {
  const readOnly = isPublicDemo();
  let evals: EvalDefinition[] = [];
  let error: string | undefined;
  try {
    evals = await listEvalDefinitions();
  } catch (cause) {
    console.error('[evals] list load failed:', cause);
    error = 'Could not load evals right now.';
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Evals</h1>
          <p className="mt-1 text-sm text-slate-500">
            Define evaluations, watch scores over time, and compare variants.
          </p>
        </div>
        <Link href="/traces" className="text-sm text-slate-500 hover:underline">
          ← Traces
        </Link>
      </header>

      {error ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="font-medium text-slate-700">Could not reach Postgres</p>
          <p className="mt-1 text-sm text-slate-500">{error}</p>
        </div>
      ) : (
        <div className="space-y-8">
          {readOnly ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Public demo — eval definitions are read-only here. Self-host TraceBloom to create and
              edit your own evals.
            </p>
          ) : (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-slate-700">New eval</h2>
              <CreateEvalForm />
            </section>
          )}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">
              Definitions ({evals.length})
            </h2>
            {evals.length === 0 ? (
              <p className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500 shadow-sm">
                No evals yet. Create one above, or run{' '}
                <code className="rounded bg-slate-100 px-1">tracebloom-eval seed</code>.
              </p>
            ) : (
              <EvalTable evals={evals} readOnly={readOnly} />
            )}
          </section>
        </div>
      )}
    </main>
  );
}
