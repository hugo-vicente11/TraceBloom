'use client';

/**
 * Live status indicator for the landing page: one fetch of /api/status on
 * mount (the endpoint caches server-side, so this stays cheap under load).
 */

import { useEffect, useState } from 'react';

type State = 'loading' | 'ok' | 'degraded';

export function StatusDot() {
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/status', { cache: 'no-store' })
      .then((response) => {
        if (!cancelled) {
          setState(response.ok ? 'ok' : 'degraded');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState('degraded');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dot =
    state === 'ok' ? 'bg-emerald-500' : state === 'degraded' ? 'bg-amber-500' : 'bg-slate-300';
  const label =
    state === 'ok' ? 'All systems live' : state === 'degraded' ? 'Partially degraded' : 'Checking…';

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
