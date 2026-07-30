/**
 * Runner configuration, resolved from the environment with sensible dev
 * defaults. Kept in one place so `main` and tests can construct it explicitly.
 */

export interface RunnerConfig {
  /** Poll interval for `--watch` mode (ms). */
  intervalMs: number;
  /** Max candidate spans scanned per eval per run. */
  batchLimit: number;
  /** Max judge calls in flight at once. */
  concurrency: number;
  /** How far back the first run (no watermark) scans (ms). */
  lookbackMs: number;
  /** Overlap re-scanned below the watermark to catch late writes (ms). */
  watermarkOverlapMs: number;
  /** Collector OTLP endpoint the judge's own spans are exported to (dogfooding). */
  collectorEndpoint: string;
  /** Judge API key (OpenAI-compatible). Judge evals are skipped when absent. */
  judgeApiKey?: string;
  /** Judge API base URL override (for OpenAI-compatible providers). */
  judgeBaseUrl?: string;
  /** Regression window (ms) over which variant stats are computed. */
  regressionWindowMs: number;
  /** Minimum samples per variant before a regression can be flagged. */
  regressionMinSamples: number;
  /** Mean-score drop (absolute, 0..1) that flags a regression. */
  meanScoreDropThreshold: number;
  /** Pass-rate drop (absolute, 0..1) that flags a regression. */
  passRateDropThreshold: number;
  /** Optional baseline variant; when unset the best-scoring variant is the baseline. */
  baselineVariant?: string;
  /** Alerting webhook stub URL; POSTed one JSON body per new regression. */
  webhookUrl?: string;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadRunnerConfig(): RunnerConfig {
  const hours = num('TRACEBLOOM_REGRESSION_WINDOW_HOURS', 24);
  return {
    intervalMs: num('TRACEBLOOM_EVAL_INTERVAL_MS', 30_000),
    batchLimit: num('TRACEBLOOM_EVAL_BATCH_LIMIT', 500),
    concurrency: num('TRACEBLOOM_EVAL_CONCURRENCY', 4),
    lookbackMs: num('TRACEBLOOM_EVAL_LOOKBACK_HOURS', 24) * 3_600_000,
    watermarkOverlapMs: num('TRACEBLOOM_EVAL_OVERLAP_SECONDS', 60) * 1_000,
    collectorEndpoint: process.env.TRACEBLOOM_ENDPOINT ?? 'http://localhost:4318',
    judgeApiKey: process.env.OPENAI_API_KEY ?? process.env.TRACEBLOOM_JUDGE_API_KEY,
    judgeBaseUrl: process.env.TRACEBLOOM_JUDGE_BASE_URL,
    regressionWindowMs: hours * 3_600_000,
    regressionMinSamples: num('TRACEBLOOM_REGRESSION_MIN_SAMPLES', 10),
    meanScoreDropThreshold: num('TRACEBLOOM_REGRESSION_MEAN_DROP', 0.1),
    passRateDropThreshold: num('TRACEBLOOM_REGRESSION_PASS_RATE_DROP', 0.1),
    baselineVariant: process.env.TRACEBLOOM_BASELINE_VARIANT,
    webhookUrl: process.env.TRACEBLOOM_EVAL_WEBHOOK_URL,
  };
}
