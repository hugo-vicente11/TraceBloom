'use client';

/**
 * Span detail: opened by clicking a row in the trace viewer. Content events
 * (prompt/response messages) and the span's full attributes are LAZY-loaded
 * from /api/traces/:traceId/spans/:spanId on open: never bulk-fetched with
 * the trace (DECISIONS.md D14). Eval scores arrive via props: they were part
 * of the (cheap) trace-level eval query and need no extra round trip.
 */

import { useEffect, useState } from 'react';
import { formatCost, formatDurationNs } from '../../../lib/format';
import type { SpanDetail, SpanEvalResult, SpanEvent } from '../../../lib/traces';

interface PanelProps {
  traceId: string;
  spanId: string;
  evals: SpanEvalResult[];
  onClose: () => void;
}

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; detail: SpanDetail };

const MESSAGE_EVENT = /^gen_ai\.(.+)\.message$/;

function eventRole(name: string): string | undefined {
  if (name === 'gen_ai.choice') {
    return 'assistant';
  }
  const match = MESSAGE_EVENT.exec(name);
  return match?.[1];
}

function bodyText(body: SpanEvent['body']): string {
  if (typeof body === 'string') {
    return body;
  }
  const content = body.content;
  if (typeof content === 'string') {
    return content;
  }
  return JSON.stringify(content ?? body, null, 2);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-slate-100 px-4 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`truncate text-xs text-slate-700 ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

function EvalSection({ evals }: { evals: SpanEvalResult[] }) {
  if (evals.length === 0) {
    return null;
  }
  return (
    <Section title={`Eval scores (${evals.length})`}>
      <ul className="space-y-2">
        {evals.map((ev) => {
          const errored = ev.errorType !== '';
          const chip = errored
            ? 'bg-amber-100 text-amber-700'
            : ev.passed
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-rose-100 text-rose-700';
          return (
            <li key={ev.evalId} className="rounded border border-slate-100 p-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-slate-700">{ev.evaluationName}</span>
                <span className={`rounded-full px-1.5 py-px font-mono text-[10px] ${chip}`}>
                  {errored
                    ? ev.errorType
                    : `${ev.scoreValue.toFixed(2)}${ev.scoreLabel ? ` · ${ev.scoreLabel}` : ''}`}
                </span>
                <span className="text-[10px] text-slate-400">
                  {ev.evaluatorType} · v{ev.evalVersion}
                </span>
              </div>
              {ev.explanation ? (
                <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{ev.explanation}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function MessageList({ events }: { events: SpanEvent[] }) {
  return (
    <ul className="space-y-2">
      {events.map((event) => {
        const role = eventRole(event.name) ?? event.name;
        const isOutput = event.name === 'gen_ai.choice' || role === 'assistant';
        const finishReason =
          typeof event.body === 'object' && typeof event.body.finish_reason === 'string'
            ? event.body.finish_reason
            : '';
        return (
          <li
            key={event.index}
            className={`rounded border p-2 ${
              isOutput ? 'border-blue-100 bg-blue-50/50' : 'border-slate-150 bg-slate-50'
            }`}
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {role}
              </span>
              {finishReason ? (
                <span className="rounded bg-slate-200 px-1 text-[10px] text-slate-600">
                  {finishReason}
                </span>
              ) : null}
            </div>
            <p className="whitespace-pre-wrap break-words text-xs text-slate-700">
              {bodyText(event.body)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function ExceptionList({ events }: { events: SpanEvent[] }) {
  return (
    <ul className="space-y-2">
      {events.map((event) => {
        const body = typeof event.body === 'object' ? event.body : {};
        const type = typeof body['exception.type'] === 'string' ? body['exception.type'] : '';
        const message =
          typeof body['exception.message'] === 'string'
            ? body['exception.message']
            : bodyText(event.body);
        const stack =
          typeof body['exception.stacktrace'] === 'string' ? body['exception.stacktrace'] : '';
        return (
          <li key={event.index} className="rounded border border-rose-200 bg-rose-50 p-2">
            <p className="text-xs font-medium text-rose-700">{type || 'exception'}</p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-rose-700">
              {message}
            </p>
            {stack ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] text-rose-500">stack trace</summary>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-[10px] text-rose-600">
                  {stack}
                </pre>
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function AttributeTable({ attributes }: { attributes: Record<string, unknown> }) {
  const entries = Object.entries(attributes);
  if (entries.length === 0) {
    return <p className="text-xs text-slate-400">none</p>;
  }
  return (
    <dl className="space-y-1">
      {entries.map(([key, value]) => {
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        return (
          <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-2">
            <dt className="truncate font-mono text-[11px] text-slate-500" title={key}>
              {key}
            </dt>
            <dd className="truncate font-mono text-[11px] text-slate-700" title={rendered}>
              {rendered}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function PanelSkeleton() {
  return (
    <div className="animate-pulse space-y-3 p-4">
      {[70, 45, 85, 60, 75].map((width) => (
        <div key={width} className="h-3 rounded bg-slate-100" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

export function SpanDetailPanel({ traceId, spanId, evals, onClose }: PanelProps) {
  const [state, setState] = useState<FetchState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is a deliberate extra dependency, the Retry button bumps it to re-run the fetch.
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetch(`/api/traces/${traceId}/spans/${spanId}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => undefined)) as
            | { error?: string }
            | undefined;
          throw new Error(body?.error ?? `HTTP ${response.status}`);
        }
        return response.json() as Promise<SpanDetail>;
      })
      .then((detail) => setState({ status: 'ready', detail }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            status: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => controller.abort();
  }, [traceId, spanId, attempt]);

  return (
    <aside
      aria-label="Span detail"
      className="w-full shrink-0 self-start rounded-lg border border-slate-200 bg-white shadow-sm xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:w-[400px] xl:overflow-y-auto"
    >
      <div className="flex items-start justify-between gap-2 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-800">
            {state.status === 'ready' ? state.detail.name : 'Span detail'}
          </h2>
          <p className="mt-0.5 font-mono text-[10px] text-slate-400">{spanId}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close panel"
          className="rounded px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          ✕
        </button>
      </div>

      {state.status === 'loading' ? <PanelSkeleton /> : null}

      {state.status === 'error' ? (
        <div className="border-t border-slate-100 p-4 text-center">
          <p className="text-sm text-slate-600">Could not load span detail</p>
          <p className="mt-1 text-xs text-slate-400">{state.message}</p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-2 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' ? <PanelBody detail={state.detail} evals={evals} /> : null}
    </aside>
  );
}

function PanelBody({ detail, evals }: { detail: SpanDetail; evals: SpanEvalResult[] }) {
  const messages = detail.events.filter((event) => eventRole(event.name) !== undefined);
  const exceptions = detail.events.filter((event) => event.name === 'exception');

  return (
    <div>
      <Section title="Status">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              detail.statusCode === 'ERROR'
                ? 'bg-rose-100 text-rose-700'
                : 'bg-emerald-100 text-emerald-700'
            }`}
          >
            {detail.statusCode}
          </span>
          {detail.statusMessage ? (
            <span className="text-xs text-rose-700">{detail.statusMessage}</span>
          ) : null}
        </div>
      </Section>

      <Section title="Span">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Meta label="Operation" value={detail.operationName || detail.kind.toLowerCase()} />
          <Meta label="Provider" value={detail.provider || '—'} />
          <Meta label="Request model" value={detail.requestModel || '—'} />
          <Meta label="Response model" value={detail.responseModel || '—'} />
          <Meta
            label="Tokens (in/out)"
            value={`${detail.inputTokens.toLocaleString()} / ${detail.outputTokens.toLocaleString()}`}
          />
          <Meta label="Cost" value={formatCost(detail.costUsd)} />
          <Meta label="Duration" value={formatDurationNs(detail.durationNs)} />
          <Meta label="Started (UTC)" value={detail.startTime} mono />
          {detail.finishReasons.length > 0 ? (
            <Meta label="Finish reasons" value={detail.finishReasons.join(', ')} />
          ) : null}
          <Meta label="Service" value={detail.serviceName || '—'} />
        </dl>
      </Section>

      <EvalSection evals={evals} />

      {exceptions.length > 0 ? (
        <Section title={`Exceptions (${exceptions.length})`}>
          <ExceptionList events={exceptions} />
        </Section>
      ) : null}

      <Section title={`Content (${messages.length})`}>
        {messages.length > 0 ? (
          <MessageList events={messages} />
        ) : (
          <p className="text-xs text-slate-400">
            No content captured for this span. Content capture is off by default — set{' '}
            <code className="rounded bg-slate-100 px-1">TRACEBLOOM_CAPTURE_CONTENT=1</code> (or{' '}
            <code className="rounded bg-slate-100 px-1">captureContent: true</code> in{' '}
            <code className="rounded bg-slate-100 px-1">init()</code>) to record prompts and
            responses as span events.
          </p>
        )}
      </Section>

      <details className="border-t border-slate-100 px-4 py-3">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Attributes ({Object.keys(detail.attributes).length})
        </summary>
        <div className="mt-2">
          <AttributeTable attributes={detail.attributes} />
        </div>
      </details>
      <details className="border-t border-slate-100 px-4 py-3">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Resource attributes ({Object.keys(detail.resourceAttributes).length})
        </summary>
        <div className="mt-2">
          <AttributeTable attributes={detail.resourceAttributes} />
        </div>
      </details>
    </div>
  );
}
