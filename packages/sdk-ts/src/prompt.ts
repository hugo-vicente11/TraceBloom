/**
 * Prompt version / variant tagging.
 *
 * The evaluation engine compares score distributions across *variants*, a
 * variant being a `gen_ai.prompt.version` label (falling back to the request
 * model). Tagging that label on a span is how you tell TraceBloom "these traces
 * came from prompt v2" so an A/B or regression check can line them up. The keys
 * are the OpenTelemetry `gen_ai.prompt.*` semantic-convention attributes.
 */

import { trace } from '@opentelemetry/api';
import { GenAIAttr } from './attributes.js';

/**
 * Tag the currently active span with a prompt version (and optional template
 * name). Call this inside a traced LLM operation:
 *
 * ```ts
 * setPromptVersion('v2', 'summarize');
 * await openai.chat.completions.create({ ... });
 * ```
 *
 * No-op when there is no active/recording span, so it is always safe to call.
 */
export function setPromptVersion(version: string, name?: string): void {
  const span = trace.getActiveSpan();
  if (!span || !span.isRecording()) {
    return;
  }
  span.setAttribute(GenAIAttr.PROMPT_VERSION, version);
  if (name) {
    span.setAttribute(GenAIAttr.PROMPT_NAME, name);
  }
}

/** Prompt tagging applied to every span emitted by an instrumented client. */
export interface PromptTag {
  /** `gen_ai.prompt.version` — the variant label. */
  promptVersion?: string;
  /** `gen_ai.prompt.name` — the prompt template name. */
  promptName?: string;
}
