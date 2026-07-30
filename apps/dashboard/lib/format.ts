/** Shared display formatting for traces (list + viewer). Pure, client-safe. */

export function formatCost(usd: number): string {
  if (usd === 0) {
    return '$0';
  }
  // Sub-cent LLM costs need precision; larger totals read better rounded.
  return usd >= 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(6)}`;
}

export function formatLatencyMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '—';
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

export function formatDurationNs(ns: number): string {
  if (!Number.isFinite(ns) || ns < 0) {
    return '—';
  }
  if (ns < 1_000_000) {
    return `${(ns / 1_000).toFixed(0)} µs`;
  }
  return formatLatencyMs(ns / 1_000_000);
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 10_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return count.toLocaleString('en-US');
}
