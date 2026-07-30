/**
 * Pure helpers for turning stored spans + their content events into evaluator
 * input, plus the deterministic sampling and variant derivation the runner
 * relies on. Kept side-effect free so they are unit-testable without a database.
 */

import { createHash } from 'node:crypto';
import type { EvaluatedSpan } from '@tracebloom/eval';

/** A gen_ai span row read from ClickHouse (raw column shape). */
export interface SpanRow {
  trace_id: string;
  span_id: string;
  response_id: string;
  request_model: string;
  operation_name: string;
  service_name: string;
  span_start_time: string;
  prompt_version: string;
  attributes_json: string;
}

/** A content event row (from `span_events`). `body` is a JSON object string. */
export interface SpanEventRow {
  span_id: string;
  name: string;
  body: string;
}

/** Events whose content forms the model *input* (the prompt). */
const INPUT_EVENTS = new Set([
  'gen_ai.system.message',
  'gen_ai.user.message',
  'gen_ai.tool.message',
]);

/** Events whose content forms the model *output* (the completion). */
const OUTPUT_EVENTS = new Set(['gen_ai.choice', 'gen_ai.assistant.message']);

function eventContent(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'content' in parsed) {
      const content = (parsed as { content: unknown }).content;
      return typeof content === 'string' ? content : JSON.stringify(content);
    }
  } catch {
    // Fall through: a non-JSON body is used verbatim.
  }
  return body;
}

/** Reconstruct the input/output text for a span from its ordered content events. */
export function reconstructIO(events: SpanEventRow[]): { input: string; output: string } {
  const input: string[] = [];
  const output: string[] = [];
  for (const event of events) {
    if (INPUT_EVENTS.has(event.name)) {
      input.push(eventContent(event.body));
    } else if (OUTPUT_EVENTS.has(event.name)) {
      output.push(eventContent(event.body));
    }
  }
  return { input: input.join('\n'), output: output.join('\n') };
}

function parseAttributes(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The variant a span belongs to: its prompt version, or the request model if untagged. */
export function computeVariant(promptVersion: string, requestModel: string): string {
  return promptVersion !== '' ? promptVersion : requestModel;
}

/** Build the evaluator's view of a span from its raw row. */
export function toEvaluatedSpan(row: SpanRow): EvaluatedSpan {
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    responseId: row.response_id,
    requestModel: row.request_model,
    operationName: row.operation_name,
    serviceName: row.service_name,
    promptVersion: row.prompt_version,
    spanStartTime: row.span_start_time,
    attributes: parseAttributes(row.attributes_json),
  };
}

/**
 * Deterministic per-span sampling decision. Hashing the span id (rather than
 * rolling a random number) makes sampling stable: the same span is always in or
 * out for a given rate, so re-runs are idempotent and don't score a different
 * subset each time. See DECISIONS.md D10.
 */
export function sampleDecision(spanId: string, rate: number): boolean {
  if (rate >= 1) {
    return true;
  }
  if (rate <= 0) {
    return false;
  }
  const hex = createHash('sha256').update(spanId).digest('hex').slice(0, 8);
  const fraction = Number.parseInt(hex, 16) / 0xffffffff;
  return fraction < rate;
}
