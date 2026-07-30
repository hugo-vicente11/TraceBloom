import type { ScorePoint } from '../../lib/evals';

/**
 * Score-over-time: a single-series line of the daily mean score (0..1). One
 * series needs no legend: the card title names it. Colors follow the validated
 * data-viz palette (series-1 blue); the accompanying drill-down list is the
 * table view that satisfies the relief rule for any sub-3:1 marks.
 */

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 16, right: 20, bottom: 28, left: 36 };
const SERIES = '#2a78d6';
const GRID = '#e1e0d9';
const AXIS_INK = '#898781';

function x(index: number, count: number): number {
  const span = WIDTH - PAD.left - PAD.right;
  if (count <= 1) {
    return PAD.left + span / 2;
  }
  return PAD.left + (span * index) / (count - 1);
}

function y(score: number): number {
  const span = HEIGHT - PAD.top - PAD.bottom;
  return PAD.top + span * (1 - Math.min(Math.max(score, 0), 1));
}

export function ScoreChart({ points }: { points: ScorePoint[] }) {
  if (points.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-slate-500">
        No scores yet in this window. Run the eval runner to populate results.
      </p>
    );
  }

  const linePath = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'} ${x(i, points.length).toFixed(1)} ${y(p.meanScore).toFixed(1)}`,
    )
    .join(' ');
  const areaPath =
    `${linePath} L ${x(points.length - 1, points.length).toFixed(1)} ${y(0).toFixed(1)}` +
    ` L ${x(0, points.length).toFixed(1)} ${y(0).toFixed(1)} Z`;

  const ticks = [0, 0.5, 1];
  const mid = Math.floor((points.length - 1) / 2);
  const last = points.length - 1;
  const xLabels: { label: string; anchor: 'start' | 'middle' | 'end'; index: number }[] = [
    { label: points[0]?.day ?? '', anchor: 'start', index: 0 },
    { label: points[mid]?.day ?? '', anchor: 'middle', index: mid },
    { label: points[last]?.day ?? '', anchor: 'end', index: last },
  ];

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="w-full"
      role="img"
      aria-label="Mean score over time"
    >
      <title>Mean score over time</title>
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={y(t)}
            y2={y(t)}
            stroke={GRID}
            strokeWidth={1}
          />
          <text x={PAD.left - 8} y={y(t) + 3} textAnchor="end" fontSize={11} fill={AXIS_INK}>
            {t.toFixed(1)}
          </text>
        </g>
      ))}
      <path d={areaPath} fill={SERIES} fillOpacity={0.1} />
      <path d={linePath} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle
          key={p.day}
          cx={x(i, points.length)}
          cy={y(p.meanScore)}
          r={points.length > 40 ? 0 : 3}
          fill={SERIES}
        >
          <title>{`${p.day}: ${p.meanScore.toFixed(2)} (n=${p.sampleCount})`}</title>
        </circle>
      ))}
      {xLabels.map((l) => (
        <text
          key={`${l.label}-${l.anchor}`}
          x={x(l.index, points.length)}
          y={HEIGHT - 8}
          textAnchor={l.anchor}
          fontSize={11}
          fill={AXIS_INK}
        >
          {l.label}
        </text>
      ))}
    </svg>
  );
}
