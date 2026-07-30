import { describe, expect, it } from 'vitest';
import {
  detectRegressions,
  type RegressionThresholds,
  selectBaseline,
  type VariantStats,
} from '../src/regression.js';

const thresholds: RegressionThresholds = {
  minSamples: 5,
  meanScoreDrop: 0.1,
  passRateDrop: 0.1,
};

describe('selectBaseline', () => {
  it('picks the highest mean-score eligible variant by default', () => {
    const stats: VariantStats[] = [
      { variant: 'a', meanScore: 0.6, passRate: 0.6, sampleCount: 10 },
      { variant: 'b', meanScore: 0.9, passRate: 0.9, sampleCount: 10 },
    ];
    expect(selectBaseline(stats, thresholds)?.variant).toBe('b');
  });

  it('ignores variants below the sample floor', () => {
    const stats: VariantStats[] = [
      { variant: 'a', meanScore: 0.5, passRate: 0.5, sampleCount: 10 },
      { variant: 'b', meanScore: 0.99, passRate: 0.99, sampleCount: 2 },
    ];
    expect(selectBaseline(stats, thresholds)?.variant).toBe('a');
  });

  it('honors an explicit baseline variant', () => {
    const stats: VariantStats[] = [
      { variant: 'a', meanScore: 0.5, passRate: 0.5, sampleCount: 10 },
      { variant: 'b', meanScore: 0.9, passRate: 0.9, sampleCount: 10 },
    ];
    expect(selectBaseline(stats, { ...thresholds, baselineVariant: 'a' })?.variant).toBe('a');
  });

  it('returns undefined when nothing has enough samples', () => {
    const stats: VariantStats[] = [{ variant: 'a', meanScore: 1, passRate: 1, sampleCount: 1 }];
    expect(selectBaseline(stats, thresholds)).toBeUndefined();
  });
});

describe('detectRegressions', () => {
  it('flags a variant whose mean score and pass rate drop past the thresholds', () => {
    const stats: VariantStats[] = [
      { variant: 'baseline', meanScore: 0.9, passRate: 0.95, sampleCount: 20 },
      { variant: 'candidate', meanScore: 0.5, passRate: 0.4, sampleCount: 20 },
    ];
    const regressions = detectRegressions(stats, thresholds);
    expect(regressions.map((r) => r.metric).sort()).toEqual(['mean_score', 'pass_rate']);
    for (const r of regressions) {
      expect(r.variant).toBe('candidate');
      expect(r.baselineVariant).toBe('baseline');
      expect(r.delta).toBeLessThan(0);
    }
  });

  it('does not flag small drops within the threshold', () => {
    const stats: VariantStats[] = [
      { variant: 'baseline', meanScore: 0.9, passRate: 0.9, sampleCount: 20 },
      { variant: 'candidate', meanScore: 0.85, passRate: 0.85, sampleCount: 20 },
    ];
    expect(detectRegressions(stats, thresholds)).toHaveLength(0);
  });

  it('never flags the baseline against itself', () => {
    const stats: VariantStats[] = [
      { variant: 'baseline', meanScore: 0.9, passRate: 0.9, sampleCount: 20 },
    ];
    expect(detectRegressions(stats, thresholds)).toHaveLength(0);
  });

  it('skips candidates below the sample floor', () => {
    const stats: VariantStats[] = [
      { variant: 'baseline', meanScore: 0.9, passRate: 0.9, sampleCount: 20 },
      { variant: 'candidate', meanScore: 0.1, passRate: 0.1, sampleCount: 3 },
    ];
    expect(detectRegressions(stats, thresholds)).toHaveLength(0);
  });
});
