/**
 * Alerting webhook stub. When a regression is newly persisted, the runner POSTs
 * a compact JSON body to a configured URL. This is intentionally a stub, no
 * real provider integration (Slack/PagerDuty/etc.) is in scope for M2, but it
 * proves the alerting seam end to end. Failures are swallowed (logged by the
 * caller): a flaky webhook must never crash the runner.
 */

import type { EvalRegression } from '@tracebloom/db';

export interface WebhookPayload {
  type: 'eval.regression';
  evalId: string;
  evalName: string;
  metric: string;
  variant: string;
  baselineVariant: string;
  baselineValue: number;
  currentValue: number;
  delta: number;
  sampleCount: number;
  detectedAt: string;
}

export function toWebhookPayload(evalName: string, regression: EvalRegression): WebhookPayload {
  return {
    type: 'eval.regression',
    evalId: regression.evalId,
    evalName,
    metric: regression.metric,
    variant: regression.variant,
    baselineVariant: regression.baselineVariant,
    baselineValue: regression.baselineValue,
    currentValue: regression.currentValue,
    delta: regression.delta,
    sampleCount: regression.sampleCount,
    detectedAt: regression.detectedAt.toISOString(),
  };
}

/** POST a payload to the webhook URL with a short timeout. Throws on failure. */
export async function postWebhook(url: string, payload: WebhookPayload): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`webhook returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
