import Link from 'next/link';
import type { ReactNode } from 'react';
import { recentModels, recentTraces, type Trace, type TraceFilters } from '../../lib/clickhouse';
import { formatCost, formatLatencyMs } from '../../lib/format';
import { LiveTraceRail } from '../LiveTraceRail';
import { TryItButton } from '../TryItButton';

// Always read fresh from ClickHouse on request.
export const dynamic = 'force-dynamic';

const TIME_PRESETS = [
  { hours: 1, label: 'Last hour' },
  { hours: 6, label: 'Last 6 hours' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 168, label: 'Last 7 days' },
  { hours: 720, label: 'Last 30 days' },
] as const;

type SearchParams = Record<string, string | string[] | undefined>;

function single(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveNumber(params: SearchParams, key: string): number | undefined {
  const raw = single(params, key);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseFilters(params: SearchParams): TraceFilters {
  const status = single(params, 'status');
  const hours = positiveNumber(params, 'hours');
  return {
    traceId: single(params, 'trace')?.toLowerCase(),
    model: single(params, 'model'),
    variant: single(params, 'variant'),
    status: status === 'ok' || status === 'error' ? status : undefined,
    hours: hours !== undefined ? Math.min(Math.trunc(hours), 24 * 365) : undefined,
    minCostUsd: positiveNumber(params, 'minCost'),
    minLatencyMs: positiveNumber(params, 'minLatency'),
  };
}

function hasActiveFilters(filters: TraceFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined);
}

function StatusBadge({ status }: { status: string }) {
  const ok = status !== 'ERROR';
  const classes = ok ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>
      {status}
    </span>
  );
}

function FilterBar({ filters, models }: { filters: TraceFilters; models: string[] }) {
  const selectClasses =
    'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700';
  const inputClasses = `${selectClasses} placeholder:text-slate-400`;
  const labelClasses = 'flex flex-col gap-1 text-xs font-medium text-slate-500';
  return (
    <form method="GET" action="/traces" className="mb-4 flex flex-wrap items-end gap-3">
      <label className={`${labelClasses} min-w-64 flex-1`}>
        Trace id
        <input
          type="search"
          name="trace"
          defaultValue={filters.traceId ?? ''}
          placeholder="Exact trace id (32 hex chars)"
          className={`${inputClasses} font-mono`}
        />
      </label>
      <label className={labelClasses}>
        Time range
        <select
          name="hours"
          defaultValue={filters.hours?.toString() ?? ''}
          className={selectClasses}
        >
          <option value="">All time</option>
          {TIME_PRESETS.map((preset) => (
            <option key={preset.hours} value={preset.hours}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClasses}>
        Model
        <select name="model" defaultValue={filters.model ?? ''} className={selectClasses}>
          <option value="">Any</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClasses}>
        Status
        <select name="status" defaultValue={filters.status ?? ''} className={selectClasses}>
          <option value="">Any</option>
          <option value="ok">OK</option>
          <option value="error">Has error</option>
        </select>
      </label>
      <label className={labelClasses}>
        Variant
        <input
          type="text"
          name="variant"
          defaultValue={filters.variant ?? ''}
          placeholder="e.g. v2"
          className={`${inputClasses} w-24`}
        />
      </label>
      <label className={labelClasses}>
        Min cost ($)
        <input
          type="number"
          name="minCost"
          step="any"
          min="0"
          defaultValue={filters.minCostUsd?.toString() ?? ''}
          className={`${inputClasses} w-24`}
        />
      </label>
      <label className={labelClasses}>
        Min latency (ms)
        <input
          type="number"
          name="minLatency"
          step="any"
          min="0"
          defaultValue={filters.minLatencyMs?.toString() ?? ''}
          className={`${inputClasses} w-28`}
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          Apply
        </button>
        <Link href="/traces" className="text-sm text-slate-500 hover:underline">
          Reset
        </Link>
      </div>
    </form>
  );
}

function TraceTable({ traces }: { traces: Trace[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3 font-medium">Trace</th>
            <th className="px-4 py-3 font-medium">Model</th>
            <th className="px-4 py-3 text-right font-medium">Spans</th>
            <th className="px-4 py-3 text-right font-medium">Tokens (in/out)</th>
            <th className="px-4 py-3 text-right font-medium">Cost</th>
            <th className="px-4 py-3 text-right font-medium">Latency</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Started (UTC)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {traces.map((trace) => (
            <tr key={trace.traceId} className="group hover:bg-slate-50">
              <td className="px-4 py-3 font-mono text-xs">
                <Link
                  href={`/traces/${trace.traceId}`}
                  title={trace.traceId}
                  className="text-slate-700 underline-offset-2 group-hover:text-blue-700 group-hover:underline"
                >
                  {trace.traceId.slice(0, 16)}…
                </Link>
              </td>
              <td className="px-4 py-3">
                {trace.model || '—'}
                {trace.variant && trace.variant !== trace.model ? (
                  <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 font-mono text-xs text-violet-700">
                    {trace.variant}
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                {trace.spanCount}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {trace.totalTokens.toLocaleString()}
                <span className="ml-1 text-xs text-slate-400">
                  ({trace.inputTokens.toLocaleString()}/{trace.outputTokens.toLocaleString()})
                </span>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{formatCost(trace.costUsd)}</td>
              <td className="px-4 py-3 text-right tabular-nums">
                {formatLatencyMs(trace.latencyMs)}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={trace.status} />
              </td>
              <td className="px-4 py-3 font-mono text-xs text-slate-500">{trace.startTime}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
      <p className="font-medium text-slate-700">{title}</p>
      <div className="mt-1 text-sm text-slate-500">{children}</div>
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const filters = parseFilters(await searchParams);
  let traces: Trace[] = [];
  let models: string[] = [];
  let error: string | undefined;
  try {
    [traces, models] = await Promise.all([recentTraces(filters), recentModels()]);
  } catch (cause) {
    console.error('[traces] list load failed:', cause);
    error = 'Could not load traces right now.';
  }
  const filtered = hasActiveFilters(filters);

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <Link href="/" className="text-xs font-medium text-slate-400 hover:text-slate-600">
            Trace<span className="text-emerald-600">Bloom</span>
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Traces</h1>
          <p className="mt-1 text-sm text-slate-500">
            Recent LLM traces — model, tokens, cost, latency and status. Click a trace to open the
            waterfall viewer.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <TryItButton />
          <Link href="/evals" className="text-sm font-medium text-slate-600 hover:underline">
            Evals →
          </Link>
        </div>
      </header>

      {error ? (
        <Notice title="Could not reach ClickHouse">
          <p>{error}</p>
          <p className="mt-2">
            Start the stack with{' '}
            <code className="rounded bg-slate-100 px-1">docker compose up</code> and apply
            migrations.
          </p>
        </Notice>
      ) : (
        <>
          <LiveTraceRail />
          <FilterBar filters={filters} models={models} />
          {traces.length === 0 ? (
            filtered ? (
              <Notice title="No traces match the current filters">
                Loosen the filters or{' '}
                <Link href="/traces" className="text-slate-700 underline">
                  reset them
                </Link>
                .
              </Notice>
            ) : (
              <Notice title="No traces yet">
                Send one with the SDK or the smoke test (
                <code className="rounded bg-slate-100 px-1">pnpm smoke</code>), or seed a multi-step
                agent trace (<code className="rounded bg-slate-100 px-1">pnpm seed:agent</code>).
              </Notice>
            )
          ) : (
            <TraceTable traces={traces} />
          )}
        </>
      )}
    </main>
  );
}
