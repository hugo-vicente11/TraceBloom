'use server';

/**
 * Server actions for the Evals view: create, enable/disable, and edit-config.
 * They validate input (reusing the evaluator config validation) and revalidate
 * the affected pages. Errors are returned as a message rather than thrown so the
 * form can show them.
 */

import { revalidatePath } from 'next/cache';
import { isPublicDemo, requireMutableConfig } from '../../lib/demo-mode';
import type { EvalSelector, EvalType } from '../../lib/evals';
import { createEvalDefinition, setEvalEnabled, updateEvalConfig } from '../../lib/evals';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const DEMO_REFUSAL: ActionResult = {
  ok: false,
  error: 'This is a read-only public demo — configuration cannot be changed here.',
};

function csv(value: FormDataEntryValue | null): string[] {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') {
    return [];
  }
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function createEvalAction(formData: FormData): Promise<ActionResult> {
  if (isPublicDemo()) {
    return DEMO_REFUSAL;
  }
  const name = String(formData.get('name') ?? '').trim();
  const type = String(formData.get('type') ?? '') as EvalType;
  const configText = String(formData.get('config') ?? '').trim();
  const sampling = Number(formData.get('samplingRate') ?? '1');

  if (name === '') {
    return { ok: false, error: 'name is required' };
  }
  if (type !== 'deterministic' && type !== 'llm_judge') {
    return { ok: false, error: 'type must be deterministic or llm_judge' };
  }

  let config: unknown;
  try {
    config = JSON.parse(configText);
  } catch {
    return { ok: false, error: 'config must be valid JSON' };
  }

  const selector: EvalSelector = {
    samplingRate: Number.isFinite(sampling) ? Math.min(Math.max(sampling, 0), 1) : 1,
    serviceNames: csv(formData.get('serviceNames')),
    models: csv(formData.get('models')),
    operations: csv(formData.get('operations')),
  };

  try {
    await createEvalDefinition({ name, type, config, selector, enabled: true });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'failed to create eval' };
  }
  revalidatePath('/evals');
  return { ok: true };
}

export async function toggleEnabledAction(id: string, enabled: boolean): Promise<void> {
  // Throws in public-demo mode: the toggle is hidden there, so a call means
  // someone is invoking the action endpoint directly.
  requireMutableConfig();
  await setEvalEnabled(id, enabled);
  revalidatePath('/evals');
  revalidatePath(`/evals/${id}`);
}

export async function updateConfigAction(id: string, configText: string): Promise<ActionResult> {
  if (isPublicDemo()) {
    return DEMO_REFUSAL;
  }
  let config: unknown;
  try {
    config = JSON.parse(configText);
  } catch {
    return { ok: false, error: 'config must be valid JSON' };
  }
  try {
    await updateEvalConfig(id, config);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'failed to update config' };
  }
  revalidatePath(`/evals/${id}`);
  return { ok: true };
}
