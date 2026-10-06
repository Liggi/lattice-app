import React, { useState } from 'react';
import { Eye, EyeOff, Loader2, Plus } from 'lucide-react';
import { contextWindowProblem, endpointHost, endpointModelProblem } from '@/constants/claude-endpoint';
import type { ClaudeEndpointSetting } from '../../services/api/types';

/** One endpoint as sent to the server: `apiKey` a string replaces, null removes, absent keeps. */
export type ClaudeEndpointUpdate = Omit<ClaudeEndpointSetting, 'apiKeyConfigured'>;

interface ClaudeEndpointsCardProps {
  endpoints: ClaudeEndpointSetting[];
  /** Saves the whole list; rejects with the server's reason. */
  onSave: (endpoints: ClaudeEndpointUpdate[]) => Promise<void>;
}

const INPUT = 'w-full px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg placeholder:text-fg-3 focus:outline-none focus:border-accent disabled:opacity-50';
const QUIET_BTN = 'px-2.5 py-1.5 rounded-md text-[13px] text-fg-3 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-50';
const PRIMARY_BTN = 'flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent-soft text-accent text-[13px] font-medium hover:bg-accent/20 transition-colors cursor-pointer disabled:opacity-50';

/** Models the session picker lists, which must not repeat; OpenAI-compatible endpoints are not in it. */
function sessionModels(endpoints: ClaudeEndpointSetting[]): string[] {
  return endpoints.filter((endpoint) => endpoint.protocol !== 'openai').map((endpoint) => endpoint.model);
}

function newId(): string {
  return `ep-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Servers a Claude session can run on instead of Anthropic. Each one is picked
 * per session by its model, next to Claude and Codex; every other session
 * keeps the Claude sign-in.
 */
export function ClaudeEndpointsCard({ endpoints, onSave }: ClaudeEndpointsCardProps): JSX.Element {
  // The endpoint being edited, 'new' while adding one, or null.
  const [editing, setEditing] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unchanged = (): ClaudeEndpointUpdate[] => endpoints.map(({ apiKeyConfigured: _shown, ...rest }) => rest);

  const save = async (list: ClaudeEndpointUpdate[], id: string): Promise<boolean> => {
    setBusyId(id);
    setError(null);
    try {
      await onSave(list);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the endpoint');
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const remove = (id: string): void => {
    void save(unchanged().filter((endpoint) => endpoint.id !== id), id).then((ok) => { if (ok && editing === id) setEditing(null); });
  };

  const submit = async (next: ClaudeEndpointUpdate): Promise<void> => {
    const list = editing === 'new'
      ? [...unchanged(), next]
      : unchanged().map((endpoint) => (endpoint.id === next.id ? next : endpoint));
    if (await save(list, next.id)) setEditing(null);
  };

  return (
    <section className="border border-line rounded-lg bg-bg" data-testid="claude-endpoints">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">Custom endpoints</p>
          <p className="mt-1 text-[13px] text-fg-3">
            Servers that speak the Anthropic Messages API, such as llama.cpp, can run a session: pick one per session; other sessions keep the Claude sign-in. OpenAI-compatible servers, such as Ollama, LM Studio or OpenRouter, run background calls only.
          </p>
        </div>
        {editing !== 'new' && (
          <button type="button" onClick={() => { setEditing('new'); setError(null); }} className={`flex items-center gap-1.5 ${QUIET_BTN}`}>
            <Plus size={14} />
            <span>Add</span>
          </button>
        )}
      </div>

      {endpoints.map((endpoint) => editing === endpoint.id ? (
        <EndpointForm
          key={endpoint.id}
          initial={endpoint}
          others={sessionModels(endpoints.filter((other) => other.id !== endpoint.id))}
          busy={busyId === endpoint.id}
          error={error}
          onCancel={() => { setEditing(null); setError(null); }}
          onSubmit={submit}
        />
      ) : (
        <div key={endpoint.id} className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
          <div className="min-w-0">
            <p className="text-[13px] font-mono text-fg break-all">{endpoint.model}</p>
            <p className="mt-0.5 text-xs text-fg-3 break-all">
              {endpointHost(endpoint.baseUrl)}
              {endpoint.protocol === 'openai'
                ? <span className="whitespace-nowrap"> · OpenAI API, background calls only</span>
                : endpoint.contextWindow ? <span className="whitespace-nowrap"> · {endpoint.contextWindow.toLocaleString('en-US')} tokens</span> : null}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" onClick={() => { setEditing(endpoint.id); setError(null); }} disabled={busyId !== null} className={QUIET_BTN}>
              Edit
            </button>
            <button type="button" onClick={() => remove(endpoint.id)} disabled={busyId !== null} className={QUIET_BTN}>
              {busyId === endpoint.id ? <Loader2 size={14} className="animate-spin" /> : 'Remove'}
            </button>
          </div>
        </div>
      ))}

      {editing === 'new' && (
        <EndpointForm
          initial={null}
          others={sessionModels(endpoints)}
          busy={busyId !== null}
          error={error}
          onCancel={() => { setEditing(null); setError(null); }}
          onSubmit={submit}
        />
      )}

      {error && editing === null && <p className="border-t border-line px-4 py-3 text-xs text-rose-300">{error}</p>}
    </section>
  );
}

/** Adds or edits one endpoint, in a tinted band where its row was. */
function EndpointForm({ initial, others, busy, error, onCancel, onSubmit }: {
  initial: ClaudeEndpointSetting | null;
  others: string[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (endpoint: ClaudeEndpointUpdate) => Promise<void>;
}): JSX.Element {
  const [protocol, setProtocol] = useState<'anthropic' | 'openai'>(initial?.protocol ?? 'anthropic');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [contextWindow, setContextWindow] = useState(initial?.contextWindow ? String(initial.contextWindow) : '');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const keySaved = initial?.apiKeyConfigured === true;
  const openai = protocol === 'openai';
  const modelProblem = model.trim() && !openai ? endpointModelProblem(model, others) : null;
  // "32,768" and "32 768" read as 32768; anything else is shown as a problem.
  const windowText = contextWindow.replace(/[\s,_]/g, '');
  const windowValue = windowText === '' ? undefined : /^\d+$/.test(windowText) ? Number(windowText) : NaN;
  const windowProblem = windowText === '' || openai ? null : contextWindowProblem(windowValue);
  const ready = baseUrl.trim() !== '' && model.trim() !== '' && !modelProblem && !windowProblem;

  const submit = (): void => {
    if (!ready || busy) return;
    void onSubmit({
      id: initial?.id ?? newId(),
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(openai ? { protocol } : windowValue !== undefined ? { contextWindow: windowValue } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : removeKey ? { apiKey: null } : {}),
    });
  };

  return (
    <div
      className="space-y-3 border-t border-line bg-surface px-4 py-4"
      onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
      data-testid="claude-endpoint-form"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="text-xs font-medium text-fg-2">Speaks</span>
        <div role="radiogroup" aria-label="The API the server speaks" className="inline-flex items-center gap-0.5 rounded-md border border-line p-0.5">
          {([['anthropic', 'Anthropic API'], ['openai', 'OpenAI API']] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={protocol === value}
              onClick={() => setProtocol(value)}
              disabled={busy}
              className={`px-2.5 py-1 text-xs rounded transition-colors cursor-pointer ${protocol === value ? 'bg-surface-2 text-fg' : 'text-fg-3 hover:text-fg'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <label htmlFor="claude-endpoint-url" className="text-xs font-medium text-fg-2">Server URL</label>
        <input
          id="claude-endpoint-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={openai ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:8080'}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          disabled={busy}
          className={INPUT}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="claude-endpoint-model" className="text-xs font-medium text-fg-2">{openai ? 'Default model' : 'Model'}</label>
        <input
          id="claude-endpoint-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={openai ? 'e.g. qwen3:4b. Each background job can name another' : 'The name the server serves, e.g. qwen3-coder'}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className={INPUT}
        />
        {modelProblem && <p className="text-xs text-amber-300">{modelProblem}</p>}
      </div>
      {!openai && <div className="space-y-2">
        <label htmlFor="claude-endpoint-context" className="text-xs font-medium text-fg-2 flex items-center gap-2">
          Context window
          <span className="text-xs text-fg-3">Optional</span>
        </label>
        <input
          id="claude-endpoint-context"
          value={contextWindow}
          onChange={(e) => setContextWindow(e.target.value)}
          placeholder="e.g. 32768. Default 200,000"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className={INPUT}
        />
        {windowProblem && <p className="text-xs text-amber-300">{windowProblem}</p>}
      </div>}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="claude-endpoint-key" className="text-xs font-medium text-fg-2 flex items-center gap-2">
            API key
            <span className="text-xs text-fg-3">Optional</span>
          </label>
          {keySaved && !removeKey && (
            <button
              type="button"
              onClick={() => { setRemoveKey(true); setApiKey(''); }}
              disabled={busy}
              className="text-xs text-fg-3 hover:text-rose-300 transition-colors cursor-pointer disabled:opacity-50"
            >
              Remove key
            </button>
          )}
        </div>
        <div className="relative">
          <input
            id="claude-endpoint-key"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setRemoveKey(false); }}
            placeholder={removeKey ? 'Removed when you save' : keySaved ? 'Saved. Type a new one to replace it' : 'Only if the server asks for one'}
            autoComplete="off"
            disabled={busy}
            className={`${INPUT} pr-10`}
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            aria-label={showKey ? 'Hide key' : 'Show key'}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-3 hover:text-fg transition-colors cursor-pointer"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex items-center justify-end gap-1">
        <button type="button" onClick={onCancel} disabled={busy} className={QUIET_BTN}>Cancel</button>
        <button type="button" onClick={submit} disabled={!ready || busy} className={PRIMARY_BTN}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
        </button>
      </div>
    </div>
  );
}
