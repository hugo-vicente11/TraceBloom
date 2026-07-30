'use client';

/**
 * Client controls for the Evals view: the create form, the enable/disable
 * toggle, and the config editor. Each calls a server action inside a transition
 * and surfaces validation errors inline.
 */

import { useState, useTransition } from 'react';
import { createEvalAction, toggleEnabledAction, updateConfigAction } from './actions';

const DETERMINISTIC_EXAMPLE = JSON.stringify(
  { target: 'output', mode: 'all', rules: [{ kind: 'valid_json' }] },
  null,
  2,
);
const JUDGE_EXAMPLE = JSON.stringify(
  {
    model: 'gpt-4o-mini',
    criteria: 'Rate helpfulness and correctness.',
    scale: { min: 1, max: 5 },
  },
  null,
  2,
);

const inputClass =
  'w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-slate-400 focus:outline-none';

export function CreateEvalForm() {
  const [error, setError] = useState<string>();
  const [type, setType] = useState<'deterministic' | 'llm_judge'>('deterministic');
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(fd) =>
        startTransition(async () => {
          const result = await createEvalAction(fd);
          setError(result.ok ? undefined : result.error);
          if (result.ok) {
            (document.getElementById('create-eval-form') as HTMLFormElement | null)?.reset();
          }
        })
      }
      id="create-eval-form"
      className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2"
    >
      <label className="text-xs font-medium text-slate-600">
        Name
        <input name="name" required className={inputClass} placeholder="answer-quality" />
      </label>
      <label className="text-xs font-medium text-slate-600">
        Type
        <select
          name="type"
          className={inputClass}
          value={type}
          onChange={(e) => setType(e.target.value as 'deterministic' | 'llm_judge')}
        >
          <option value="deterministic">deterministic</option>
          <option value="llm_judge">llm_judge</option>
        </select>
      </label>
      <label className="text-xs font-medium text-slate-600">
        Operations (csv)
        <input name="operations" className={inputClass} placeholder="chat" />
      </label>
      <label className="text-xs font-medium text-slate-600">
        Models (csv)
        <input name="models" className={inputClass} placeholder="gpt-4o" />
      </label>
      <label className="text-xs font-medium text-slate-600">
        Service names (csv)
        <input name="serviceNames" className={inputClass} placeholder="my-app" />
      </label>
      <label className="text-xs font-medium text-slate-600">
        Sampling rate (0–1)
        <input
          name="samplingRate"
          type="number"
          step="0.05"
          min="0"
          max="1"
          defaultValue="1"
          className={inputClass}
        />
      </label>
      <label className="text-xs font-medium text-slate-600 sm:col-span-2">
        Config (JSON)
        <textarea
          name="config"
          rows={7}
          className={`${inputClass} font-mono`}
          defaultValue={type === 'deterministic' ? DETERMINISTIC_EXAMPLE : JUDGE_EXAMPLE}
          key={type}
        />
      </label>
      {error ? <p className="text-xs text-rose-600 sm:col-span-2">{error}</p> : null}
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {pending ? 'Creating…' : 'Create eval'}
        </button>
      </div>
    </form>
  );
}

export function EnableToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => toggleEnabledAction(id, !enabled))}
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'
      } disabled:opacity-50`}
    >
      {enabled ? 'enabled' : 'disabled'}
    </button>
  );
}

export function ConfigEditor({ id, config }: { id: string; config: string }) {
  const [text, setText] = useState(config);
  const [message, setMessage] = useState<string>();
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        className={`${inputClass} font-mono`}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await updateConfigAction(id, text);
              setMessage(result.ok ? 'Saved — version bumped.' : result.error);
            })
          }
          className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save config'}
        </button>
        {message ? <span className="text-xs text-slate-500">{message}</span> : null}
      </div>
    </div>
  );
}
