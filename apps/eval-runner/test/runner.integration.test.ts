/**
 * End-to-end runner test against real ClickHouse + Postgres. Skipped unless both
 * TRACEBLOOM_TEST_CLICKHOUSE_URL and DATABASE_URL are set (CI provides them).
 *
 * It writes spans + content events straight into ClickHouse (simulating landed
 * traces), defines a deterministic eval in Postgres, runs the runner, and asserts
 * results are written, re-runs are idempotent, and a regression is detected and
 * persisted for the worse variant.
 */

import { type ClickHouseClient, createClient } from '@clickhouse/client';
import { createDb, type EvalDefinition, evalDefinitions, evalRegressions } from '@tracebloom/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRunnerConfig } from '../src/env.js';
import { type RunnerDeps, runEval } from '../src/runner.js';

const CH_URL = process.env.TRACEBLOOM_TEST_CLICKHOUSE_URL;
const PG_URL = process.env.DATABASE_URL;
const run = CH_URL && PG_URL ? describe : describe.skip;

function chDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

run('eval runner (integration)', () => {
  const suffix = Date.now().toString(36);
  const service = `eval-it-${suffix}`;
  const baseTime = new Date();
  // Created in beforeAll so nothing connects when the suite is skipped.
  let ch: ClickHouseClient;
  let db: ReturnType<typeof createDb>['db'];
  let pool: ReturnType<typeof createDb>['pool'];
  let def: EvalDefinition;

  function insertSpan(id: string, variant: string, output: string): Promise<void> {
    return insertSpanFor(service, id, variant, output);
  }

  async function insertSpanFor(
    svc: string,
    id: string,
    variant: string,
    output: string,
  ): Promise<void> {
    await ch.insert({
      table: 'tracebloom.spans',
      format: 'JSONEachRow',
      values: [
        {
          trace_id: `trace-${id}`,
          span_id: id,
          name: 'chat gpt-4o',
          kind: 'CLIENT',
          start_time: chDateTime(baseTime),
          end_time: chDateTime(baseTime),
          status_code: 'OK',
          service_name: svc,
          operation_name: 'chat',
          request_model: 'gpt-4o',
          response_id: `resp-${id}`,
          attributes_json: JSON.stringify({ 'gen_ai.prompt.version': variant }),
        },
      ],
    });
    await ch.insert({
      table: 'tracebloom.span_events',
      format: 'JSONEachRow',
      values: [
        {
          trace_id: `trace-${id}`,
          span_id: id,
          event_index: 0,
          name: 'gen_ai.user.message',
          timestamp: chDateTime(baseTime),
          body: JSON.stringify({ content: 'question' }),
        },
        {
          trace_id: `trace-${id}`,
          span_id: id,
          event_index: 1,
          name: 'gen_ai.choice',
          timestamp: chDateTime(baseTime),
          body: JSON.stringify({ index: 0, content: output }),
        },
      ],
    });
  }

  function deps(): RunnerDeps {
    const config = loadRunnerConfig();
    return {
      ch,
      db,
      // 1 min ahead so all spans fall at/under `until`; long window & low floor.
      now: () => new Date(baseTime.getTime() + 60_000),
      config: {
        ...config,
        lookbackMs: 7 * 24 * 3_600_000,
        regressionWindowMs: 7 * 24 * 3_600_000,
        regressionMinSamples: 2,
        meanScoreDropThreshold: 0.4,
        passRateDropThreshold: 0.4,
        baselineVariant: undefined,
        webhookUrl: undefined,
      },
    };
  }

  async function resultCount(): Promise<number> {
    const rs = await ch.query({
      query: `SELECT toString(count()) AS c FROM tracebloom.eval_results FINAL WHERE eval_id = {id:String}`,
      query_params: { id: def.id },
      format: 'JSONEachRow',
    });
    const rows = await rs.json<{ c: string }>();
    return Number(rows[0]?.c ?? '0');
  }

  beforeAll(async () => {
    ch = createClient({ url: CH_URL, database: 'tracebloom' });
    ({ db, pool } = createDb(PG_URL));

    const variantA = `A-${suffix}`;
    const variantB = `B-${suffix}`;
    // Variant A always contains "good" (passes); variant B never does (fails).
    await insertSpan(`a1-${suffix}`, variantA, 'good answer one');
    await insertSpan(`a2-${suffix}`, variantA, 'good answer two');
    await insertSpan(`a3-${suffix}`, variantA, 'good answer three');
    await insertSpan(`b1-${suffix}`, variantB, 'weak reply one');
    await insertSpan(`b2-${suffix}`, variantB, 'weak reply two');
    await insertSpan(`b3-${suffix}`, variantB, 'weak reply three');

    const [row] = await db
      .insert(evalDefinitions)
      .values({
        name: `contains-good-${suffix}`,
        type: 'deterministic',
        config: { target: 'output', rules: [{ kind: 'contains', text: 'good' }] },
        selector: { serviceNames: [service], samplingRate: 1 },
        enabled: true,
      })
      .returning();
    def = row as EvalDefinition;
  });

  afterAll(async () => {
    if (def) {
      await db.delete(evalDefinitions).where(eq(evalDefinitions.id, def.id));
    }
    await ch.close();
    await pool.end();
  });

  it('scores landed spans and writes OTel-shaped results', async () => {
    const summary = await runEval(deps(), def);
    expect(summary.scanned).toBe(6);
    expect(summary.scored).toBe(6);
    expect(await resultCount()).toBe(6);

    const rs = await ch.query({
      query: `SELECT variant, toString(passed) AS passed, score_value, evaluator_type, evaluation_name
              FROM tracebloom.eval_results FINAL WHERE eval_id = {id:String} ORDER BY variant`,
      query_params: { id: def.id },
      format: 'JSONEachRow',
    });
    const rows = await rs.json<{
      variant: string;
      passed: string;
      score_value: number;
      evaluator_type: string;
      evaluation_name: string;
    }>();
    const a = rows.find((r) => r.variant.startsWith('A-'));
    const b = rows.find((r) => r.variant.startsWith('B-'));
    expect(a?.passed).toBe('1');
    expect(a?.score_value).toBe(1);
    expect(b?.passed).toBe('0');
    expect(b?.score_value).toBe(0);
    expect(a?.evaluator_type).toBe('deterministic');
    expect(a?.evaluation_name).toBe(`contains-good-${suffix}`);
  });

  it('is idempotent: a second run writes no new rows', async () => {
    const summary = await runEval(deps(), def);
    expect(summary.scored).toBe(0);
    expect(summary.skippedExisting).toBe(6);
    expect(await resultCount()).toBe(6);
  });

  it('detects and persists a regression for the worse variant', async () => {
    const regressions = await db
      .select()
      .from(evalRegressions)
      .where(eq(evalRegressions.evalId, def.id));
    // Variant B regresses vs baseline A on both mean score and pass rate.
    expect(regressions.length).toBeGreaterThanOrEqual(2);
    const metrics = new Set(regressions.map((r) => r.metric));
    expect(metrics.has('mean_score')).toBe(true);
    expect(metrics.has('pass_rate')).toBe(true);
    for (const r of regressions) {
      expect(r.variant.startsWith('B-')).toBe(true);
      expect(r.baselineVariant.startsWith('A-')).toBe(true);
    }
  });

  it('runs an llm_judge eval through a mock judge client (no API key)', async () => {
    const judgeService = `${service}-judge`;
    await insertSpanFor(judgeService, `j1-${suffix}`, `J-${suffix}`, 'the answer');

    const [judgeDef] = await db
      .insert(evalDefinitions)
      .values({
        name: `judge-${suffix}`,
        type: 'llm_judge',
        config: {
          model: 'gpt-4o-mini',
          criteria: 'Is it a real answer?',
          scale: { min: 1, max: 5 },
        },
        selector: { serviceNames: [judgeService], samplingRate: 1 },
        enabled: true,
      })
      .returning();

    // Injected mock judge: no network, no API key. Returns a fixed verdict.
    const judgeClient = {
      chat: {
        completions: {
          create: async () => ({
            id: 'chatcmpl-mock',
            model: 'gpt-4o-mini',
            choices: [
              {
                finish_reason: 'stop',
                message: { role: 'assistant', content: '{"score":4,"pass":true,"reason":"solid"}' },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        },
      },
    };

    try {
      const summary = await runEval({ ...deps(), judgeClient }, judgeDef as EvalDefinition);
      expect(summary.scored).toBe(1);
      expect(summary.errors).toBe(0);

      const rs = await ch.query({
        query: `SELECT evaluator_type, score_value, toString(passed) AS passed, explanation
                FROM tracebloom.eval_results FINAL WHERE eval_id = {id:String}`,
        query_params: { id: judgeDef.id },
        format: 'JSONEachRow',
      });
      const [row] = await rs.json<{
        evaluator_type: string;
        score_value: number;
        passed: string;
        explanation: string;
      }>();
      expect(row?.evaluator_type).toBe('llm_judge');
      expect(row?.score_value).toBeCloseTo(0.75, 5); // (4-1)/(5-1)
      expect(row?.passed).toBe('1');
      expect(row?.explanation).toBe('solid');
    } finally {
      await db.delete(evalDefinitions).where(eq(evalDefinitions.id, judgeDef.id));
    }
  });
});
