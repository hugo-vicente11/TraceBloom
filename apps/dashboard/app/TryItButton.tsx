'use client';

/**
 * The "Run a live agent" button: starts a sandbox run, waits for its first
 * span to land (the trace page 404s until then), and navigates to the live
 * viewer where the M5 stream takes over. Rate-limit and capacity errors from
 * the API are surfaced inline.
 */

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

type Phase = 'idle' | 'starting' | 'error';

const FIRST_SPAN_POLL_MS = 800;
const FIRST_SPAN_POLL_TRIES = 25; // ~20s — the first span lands ~5s in

export function TryItButton({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string>();
  const busy = useRef(false);

  async function run(): Promise<void> {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setPhase('starting');
    setMessage(undefined);
    try {
      const response = await fetch('/api/try-it', { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as {
        traceId?: string;
        error?: string;
      };
      if (!response.ok || !body.traceId) {
        setPhase('error');
        setMessage(body.error ?? `sandbox unavailable (${response.status})`);
        return;
      }
      for (let attempt = 0; attempt < FIRST_SPAN_POLL_TRIES; attempt++) {
        const probe = await fetch(`/api/traces/${body.traceId}`, { cache: 'no-store' });
        if (probe.ok) {
          router.push(`/traces/${body.traceId}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, FIRST_SPAN_POLL_MS));
      }
      setPhase('error');
      setMessage('The run started but no spans arrived in time — is the collector up?');
    } catch (cause) {
      setPhase('error');
      setMessage(cause instanceof Error ? cause.message : 'sandbox request failed');
    } finally {
      busy.current = false;
    }
  }

  const sizing =
    size === 'lg' ? 'px-5 py-2.5 text-base rounded-lg' : 'px-3 py-1.5 text-sm rounded-md';

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void run()}
        disabled={phase === 'starting'}
        className={`${sizing} inline-flex items-center gap-2 bg-emerald-600 font-medium text-white shadow-sm transition-colors hover:bg-emerald-500 disabled:cursor-wait disabled:bg-emerald-400`}
      >
        {phase === 'starting' ? (
          <>
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            Starting agent…
          </>
        ) : (
          <>▶ Run a live agent</>
        )}
      </button>
      {phase === 'error' && message ? (
        <span className="max-w-72 text-xs text-rose-600">{message}</span>
      ) : null}
    </span>
  );
}
