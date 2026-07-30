/**
 * Public-demo guard: with TRACEBLOOM_PUBLIC_DEMO set, every mutating server
 * action refuses before touching a database (these tests run with no database
 * configured: a guard miss would surface as a connection error, not a clean
 * refusal). This is the app layer of the read-only guarantee; the DB layer
 * (SELECT-only credentials) is asserted by the deploy smoke test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createEvalAction, toggleEnabledAction, updateConfigAction } from '../app/evals/actions';
import { DemoModeError, isPublicDemo, requireMutableConfig } from '../lib/demo-mode';

describe('demo mode', () => {
  const original = process.env.TRACEBLOOM_PUBLIC_DEMO;

  beforeEach(() => {
    process.env.TRACEBLOOM_PUBLIC_DEMO = '1';
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env.TRACEBLOOM_PUBLIC_DEMO;
    } else {
      process.env.TRACEBLOOM_PUBLIC_DEMO = original;
    }
  });

  it('is detected from the environment', () => {
    expect(isPublicDemo()).toBe(true);
    expect(() => requireMutableConfig()).toThrow(DemoModeError);

    delete process.env.TRACEBLOOM_PUBLIC_DEMO;
    expect(isPublicDemo()).toBe(false);
    expect(() => requireMutableConfig()).not.toThrow();
  });

  it('createEvalAction refuses without touching the database', async () => {
    const fd = new FormData();
    fd.set('name', 'sneaky');
    fd.set('type', 'deterministic');
    fd.set('config', '{"rules":[{"kind":"valid_json"}]}');
    const result = await createEvalAction(fd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/read-only public demo/);
  });

  it('updateConfigAction refuses without touching the database', async () => {
    const result = await updateConfigAction('some-id', '{"rules":[]}');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/read-only public demo/);
  });

  it('toggleEnabledAction throws the demo-mode error', async () => {
    await expect(toggleEnabledAction('some-id', false)).rejects.toThrow(DemoModeError);
  });
});
