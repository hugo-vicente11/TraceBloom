/**
 * Variant comparison and regression detection: the pure decision logic. Given
 * per-variant score statistics and a baseline, it decides which variants have
 * regressed on mean score or pass rate. The runner handles the I/O (reading
 * stats from ClickHouse, persisting signals to Postgres, firing the webhook).
 */

import type { RegressionMetric } from '@tracebloom/db';

/** Aggregated scores for one variant over the comparison window. */
export interface VariantStats {
  variant: string;
  meanScore: number;
  passRate: number;
  sampleCount: number;
}

export interface RegressionThresholds {
  minSamples: number;
  meanScoreDrop: number;
  passRateDrop: number;
  /** Explicit baseline variant; when unset the highest mean-score variant is used. */
  baselineVariant?: string;
}

/** A detected regression of one variant versus the baseline on a single metric. */
export interface Regression {
  metric: RegressionMetric;
  variant: string;
  baselineVariant: string;
  baselineValue: number;
  currentValue: number;
  delta: number;
  threshold: number;
  sampleCount: number;
}

/**
 * Choose the baseline variant: the explicit one if it has enough samples,
 * otherwise the eligible variant with the highest mean score (the incumbent we
 * measure regressions against). Returns `undefined` when nothing qualifies.
 */
export function selectBaseline(
  stats: VariantStats[],
  thresholds: RegressionThresholds,
): VariantStats | undefined {
  const eligible = stats.filter((s) => s.sampleCount >= thresholds.minSamples);
  if (eligible.length === 0) {
    return undefined;
  }
  if (thresholds.baselineVariant) {
    return eligible.find((s) => s.variant === thresholds.baselineVariant);
  }
  return eligible.reduce((best, s) => (s.meanScore > best.meanScore ? s : best));
}

/**
 * Detect regressions: every eligible non-baseline variant whose mean score or
 * pass rate is below the baseline by more than the configured threshold.
 */
export function detectRegressions(
  stats: VariantStats[],
  thresholds: RegressionThresholds,
): Regression[] {
  const baseline = selectBaseline(stats, thresholds);
  if (!baseline) {
    return [];
  }
  const regressions: Regression[] = [];
  for (const candidate of stats) {
    if (candidate.variant === baseline.variant || candidate.sampleCount < thresholds.minSamples) {
      continue;
    }
    const meanDelta = candidate.meanScore - baseline.meanScore;
    if (-meanDelta > thresholds.meanScoreDrop) {
      regressions.push({
        metric: 'mean_score',
        variant: candidate.variant,
        baselineVariant: baseline.variant,
        baselineValue: baseline.meanScore,
        currentValue: candidate.meanScore,
        delta: meanDelta,
        threshold: thresholds.meanScoreDrop,
        sampleCount: candidate.sampleCount,
      });
    }
    const passDelta = candidate.passRate - baseline.passRate;
    if (-passDelta > thresholds.passRateDrop) {
      regressions.push({
        metric: 'pass_rate',
        variant: candidate.variant,
        baselineVariant: baseline.variant,
        baselineValue: baseline.passRate,
        currentValue: candidate.passRate,
        delta: passDelta,
        threshold: thresholds.passRateDrop,
        sampleCount: candidate.sampleCount,
      });
    }
  }
  return regressions;
}
