/**
 * Seeds a couple of illustrative eval definitions so the runner has something to
 * do out of the box: one deterministic guardrail and one LLM-as-judge quality
 * score. Idempotent: re-seeding does nothing (names are unique).
 */

import { type Database, type EvalDefinition, evalDefinitions } from '@tracebloom/db';

export async function seedSampleEvals(db: Database): Promise<EvalDefinition[]> {
  const inserted = await db
    .insert(evalDefinitions)
    .values([
      {
        name: 'no-refusal',
        type: 'deterministic',
        config: {
          target: 'output',
          mode: 'all',
          rules: [
            { kind: 'not_contains', text: 'I cannot', caseSensitive: false },
            { kind: 'not_contains', text: 'as an AI', caseSensitive: false },
            { kind: 'max_length', max: 4000 },
          ],
        },
        selector: { operations: ['chat'], samplingRate: 1 },
        enabled: true,
      },
      {
        name: 'answer-quality',
        type: 'llm_judge',
        config: {
          model: 'gpt-4o-mini',
          criteria:
            'Rate how helpful, correct, and complete the assistant output is as a response to the input.',
          scale: { min: 1, max: 5 },
          passThreshold: 0.6,
        },
        selector: { operations: ['chat'], samplingRate: 1 },
        enabled: true,
      },
    ])
    .onConflictDoNothing({ target: evalDefinitions.name })
    .returning();
  return inserted;
}
