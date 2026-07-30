import Link from 'next/link';

export default function TraceNotFound() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="font-medium text-slate-700">Trace not found</p>
        <p className="mt-1 text-sm text-slate-500">
          No spans exist for this trace id. It may not have landed yet (spans are batched), the id
          may be mistyped, or the trace may have aged out (30-day TTL).
        </p>
        <Link
          href="/traces"
          className="mt-4 inline-block text-sm font-medium text-slate-600 hover:underline"
        >
          ← Back to traces
        </Link>
      </div>
    </main>
  );
}
