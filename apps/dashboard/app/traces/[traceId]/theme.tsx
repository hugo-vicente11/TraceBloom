/**
 * Category styling for the trace viewer. Colors are the validated data-viz
 * categorical slots in fixed order (llm=blue, tool=aqua, agent=yellow);
 * generic spans are deliberately neutral gray: "no identity". Identity is
 * never color-alone: every row pairs the color with a per-category icon and
 * the span's name/metrics as text. Errors use the reserved status red.
 */

import type { SpanCategory } from '../../../lib/trace-tree';

export const CATEGORY_META: Record<SpanCategory, { color: string; label: string }> = {
  llm: { color: '#2a78d6', label: 'LLM call' },
  tool: { color: '#1baf7a', label: 'Tool' },
  agent: { color: '#eda100', label: 'Agent' },
  generic: { color: '#898781', label: 'Span' },
};

/** Reserved status red for error bars/badges (never used as a series color). */
export const ERROR_COLOR = '#d03b3b';

/**
 * In-progress (pending placeholder) bars/badges: live mode only. Sky, so it
 * reads as "activity" without colliding with the llm blue or the status
 * colors; always paired with the pulsing animation and a "running" label.
 */
export const RUNNING_COLOR = '#38bdf8';

const ICON_PATHS: Record<SpanCategory, React.ReactNode> = {
  // Speech bubble
  llm: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  // Wrench
  tool: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  // Robot head
  agent: (
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </>
  ),
  generic: <circle cx="12" cy="12" r="4" />,
};

export function CategoryIcon({ category, size = 12 }: { category: SpanCategory; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={CATEGORY_META[category].color}
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label={CATEGORY_META[category].label}
      role="img"
      className="shrink-0"
    >
      <title>{CATEGORY_META[category].label}</title>
      {ICON_PATHS[category]}
    </svg>
  );
}
