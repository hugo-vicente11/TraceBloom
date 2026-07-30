import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getTraceDetail,
  isValidSpanId,
  isValidTraceId,
  type TraceDetail,
} from '../../../lib/traces';
import { TraceView } from './TraceView';

export const dynamic = 'force-dynamic';

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
      <p className="font-medium text-slate-700">Could not load this trace</p>
      <p className="mt-1 text-sm text-slate-500">{message}</p>
      <p className="mt-2 text-sm text-slate-500">
        Is the stack up? Start it with{' '}
        <code className="rounded bg-slate-100 px-1">pnpm stack:up</code>.
      </p>
    </div>
  );
}

export default async function TracePage({
  params,
  searchParams,
}: {
  params: Promise<{ traceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { traceId: rawId } = await params;
  const traceId = rawId.toLowerCase();
  if (!isValidTraceId(traceId)) {
    notFound();
  }

  const spanParam = (await searchParams).span;
  const rawSpan = (Array.isArray(spanParam) ? spanParam[0] : spanParam)?.toLowerCase();
  const initialSpanId = rawSpan && isValidSpanId(rawSpan) ? rawSpan : undefined;

  let detail: TraceDetail | undefined;
  let error: string | undefined;
  try {
    detail = await getTraceDetail(traceId);
  } catch (cause) {
    console.error(`[traces] detail load failed for ${traceId}:`, cause);
    error = 'Could not load this trace right now.';
  }

  if (error !== undefined) {
    return (
      <main className="mx-auto max-w-[1400px] px-6 py-10">
        <Link href="/traces" className="text-sm text-slate-500 hover:underline">
          ← Traces
        </Link>
        <div className="mt-4">
          <ErrorNotice message={error} />
        </div>
      </main>
    );
  }
  if (!detail) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-[1400px] px-6 py-8">
      {/* Client shell: subscribes to the live stream when the trace is
          still running; otherwise renders the snapshot exactly as M3 did. */}
      <TraceView detail={detail} initialSpanId={initialSpanId} />
    </main>
  );
}
