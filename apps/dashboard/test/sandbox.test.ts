/**
 * Sandbox boundedness: the run is a real Vercel AI SDK agent (mock model, no
 * keys) captured by createAISDKTelemetry: it produces the scripted, bounded
 * gen_ai tree under the sandbox service/variant, honors the concurrency and
 * daily-budget caps, and the watchdog aborts an over-long run while releasing
 * its slot. Spans are captured with an in-memory processor, no collector.
 */

import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureSandboxSdk,
  resetSandboxStateForTests,
  SANDBOX_LIMITS,
  SANDBOX_SERVICE,
  SANDBOX_VARIANT,
  ScopeFilterSpanProcessor,
  startSandboxRun,
} from '../lib/sandbox';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  ensureSandboxSdk({ spanProcessor: new SimpleSpanProcessor(exporter) });
});

beforeEach(() => {
  resetSandboxStateForTests();
  exporter.reset();
});

describe('startSandboxRun', () => {
  it('produces the scripted, bounded trace under the sandbox namespace', async () => {
    const result = await startSandboxRun({ paceScale: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
    await result.done;

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(SANDBOX_LIMITS.spansPerRun);
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(result.traceId);
      expect(span.resource.attributes['service.name']).toBe(SANDBOX_SERVICE);
      // Every span is a canonical gen_ai operation: no framework/vendor noise.
      expect(['invoke_agent', 'execute_task', 'chat', 'execute_tool']).toContain(
        span.attributes['gen_ai.operation.name'],
      );
      // Everything carries the sandbox variant (not v1/v2, A/B stays clean).
      expect(span.attributes['gen_ai.prompt.version']).toBe(SANDBOX_VARIANT);
    }

    const byOp = (op: string) => spans.filter((s) => s.attributes['gen_ai.operation.name'] === op);
    // invoke_agent root + 3 steps + 3 model calls + 2 search attempts.
    expect(byOp('invoke_agent')).toHaveLength(1);
    expect(byOp('execute_task')).toHaveLength(3);
    expect(byOp('chat')).toHaveLength(3);
    expect(byOp('execute_tool')).toHaveLength(2);

    const root = spans.find((s) => !s.parentSpanContext?.spanId)!;
    expect(root.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(root.attributes['gen_ai.agent.name']).toBe('researcher');
    for (const chat of byOp('chat')) {
      expect(chat.attributes['gen_ai.request.model']).toBe('gpt-4o-2024-08-06');
    }

    // The scripted failure: exactly one errored search attempt, retried OK.
    const searches = byOp('execute_tool');
    const failed = searches.filter((s) => s.status.code === 2); // ERROR
    expect(failed).toHaveLength(1);

    // The draft output is a refusal ("I cannot …"): the demo's eval-chip moment.
    const refusal = byOp('chat').find((s) =>
      s.events.some(
        (e) => e.name === 'gen_ai.choice' && String(e.attributes?.content).includes('I cannot'),
      ),
    );
    expect(refusal).toBeDefined();
  });

  it('enforces the concurrency cap and releases slots when runs finish', async () => {
    const limits = { maxConcurrent: 2 };
    const first = await startSandboxRun({ paceScale: 0, limits });
    const second = await startSandboxRun({ paceScale: 0, limits });
    expect(first.ok && second.ok).toBe(true);

    const third = await startSandboxRun({ paceScale: 0, limits });
    expect(third).toEqual({ ok: false, reason: 'concurrency' });

    if (first.ok) {
      await first.done;
    }
    if (second.ok) {
      await second.done;
    }
    const fourth = await startSandboxRun({ paceScale: 0, limits });
    expect(fourth.ok).toBe(true);
    if (fourth.ok) {
      await fourth.done;
    }
  });

  it('enforces the daily budget', async () => {
    const limits = { dailyBudget: 1 };
    const first = await startSandboxRun({ paceScale: 0, limits });
    expect(first.ok).toBe(true);
    if (first.ok) {
      await first.done;
    }
    const second = await startSandboxRun({ paceScale: 0, limits });
    expect(second).toEqual({ ok: false, reason: 'budget' });
  });

  it('watchdog aborts an over-long run and releases its slot', async () => {
    // Full pace but a 300ms budget: the chunked pause hits the deadline fast.
    const result = await startSandboxRun({ paceScale: 1, limits: { maxRunMs: 300 } });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const started = Date.now();
    await result.done;
    expect(Date.now() - started).toBeLessThan(3_000);

    // Slot released: a fresh run is admitted immediately.
    const next = await startSandboxRun({ paceScale: 0, limits: { maxConcurrent: 1 } });
    expect(next.ok).toBe(true);
    if (next.ok) {
      await next.done;
    }
  });
});

describe('ScopeFilterSpanProcessor', () => {
  it("drops spans from foreign scopes (e.g. Next.js's built-in instrumentation)", async () => {
    // The sandbox SDK is already initialized with a plain processor above, so
    // exercise the filter directly through a second provider.
    const { BasicTracerProvider } = await import('@opentelemetry/sdk-trace-base');
    const scoped = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new ScopeFilterSpanProcessor(new SimpleSpanProcessor(scoped), '@tracebloom/sdk'),
      ],
    });
    provider.getTracer('next.js').startSpan('POST /api/try-it').end();
    provider.getTracer('@tracebloom/sdk').startSpan('chat gpt-4o').end();
    await provider.forceFlush();

    const names = scoped.getFinishedSpans().map((s) => s.name);
    expect(names).toEqual(['chat gpt-4o']);
    await provider.shutdown();
  });
});
