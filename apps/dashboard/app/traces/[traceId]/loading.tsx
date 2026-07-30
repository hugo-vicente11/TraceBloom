/** Route-level loading state: a skeleton of the header + waterfall rows. */
export default function LoadingTrace() {
  const widths = [82, 64, 71, 55, 76, 48, 68, 60];
  return (
    <main className="mx-auto max-w-[1400px] animate-pulse px-6 py-8">
      <div className="h-4 w-16 rounded bg-slate-200" />
      <div className="mt-3 h-6 w-96 max-w-full rounded bg-slate-200" />
      <div className="mt-4 flex gap-8">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-9 w-24 rounded bg-slate-100" />
        ))}
      </div>
      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        {widths.map((width) => (
          <div key={width} className="flex items-center gap-4 py-2">
            <div className="h-3 rounded bg-slate-100" style={{ width: `${width * 3}px` }} />
            <div className="ml-auto h-3 rounded bg-slate-100" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
    </main>
  );
}
