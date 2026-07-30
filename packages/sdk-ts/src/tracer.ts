/**
 * SDK initialization: wires an OpenTelemetry tracer provider with an OTLP/HTTP
 * (protobuf) exporter pointed at the TraceBloom collector. `init()` is the one
 * documented setup call; everything else (auto-instrumentation) uses the state
 * it establishes.
 */

import { type Tracer, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { DEFAULT_PRICING, type PricingMap } from './pricing.js';

const TRACER_NAME = '@tracebloom/sdk';
const TRACER_VERSION = '0.1.0';
const DEFAULT_ENDPOINT = 'http://localhost:4318';

export interface TraceBloomConfig {
  /** Collector OTLP/HTTP base URL. `/v1/traces` is appended. Default `http://localhost:4318`. */
  endpoint?: string;
  /** Logical service name recorded on every span. Default `tracebloom-app`. */
  serviceName?: string;
  /**
   * Record prompt/response content as span events. Off by default (and via
   * `TRACEBLOOM_CAPTURE_CONTENT=1`) so no content leaves the process unless
   * explicitly opted in.
   */
  captureContent?: boolean;
  /** Override the token pricing map used for cost computation. */
  pricing?: PricingMap;
  /** Extra headers for the OTLP exporter (e.g. auth for a hosted collector). */
  headers?: Record<string, string>;
  /**
   * Advanced/testing: use this span processor instead of the default OTLP
   * batch processor (e.g. an in-memory processor in tests).
   */
  spanProcessor?: SpanProcessor;
}

export interface RuntimeState {
  tracer: Tracer;
  pricing: PricingMap;
  captureContent: boolean;
}

let provider: NodeTracerProvider | undefined;
let state: RuntimeState | undefined;

function envCaptureContent(): boolean {
  const value = process.env.TRACEBLOOM_CAPTURE_CONTENT;
  return value === '1' || value === 'true';
}

/** Initialize TraceBloom tracing. Idempotent: a second call is a no-op until `shutdown()`. */
export function init(config: TraceBloomConfig = {}): void {
  if (provider) {
    return;
  }

  const endpoint = config.endpoint ?? process.env.TRACEBLOOM_ENDPOINT ?? DEFAULT_ENDPOINT;
  const serviceName = config.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'tracebloom-app';
  const captureContent = config.captureContent ?? envCaptureContent();

  const processor =
    config.spanProcessor ??
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: `${endpoint.replace(/\/+$/, '')}/v1/traces`,
        headers: config.headers,
      }),
    );

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    spanProcessors: [processor],
  });
  provider.register();

  state = {
    tracer: trace.getTracer(TRACER_NAME, TRACER_VERSION),
    pricing: config.pricing ?? DEFAULT_PRICING,
    captureContent,
  };
}

/** Flush and tear down the tracer provider. Safe to call when not initialized. */
export async function shutdown(): Promise<void> {
  const current = provider;
  provider = undefined;
  state = undefined;
  if (current) {
    await current.shutdown();
    trace.disable();
  }
}

/** Internal: the active runtime state, or throw a helpful error if `init()` was skipped. */
export function getState(): RuntimeState {
  if (!state) {
    throw new Error(
      'TraceBloom is not initialized. Call init() once at startup before instrumenting calls.',
    );
  }
  return state;
}
