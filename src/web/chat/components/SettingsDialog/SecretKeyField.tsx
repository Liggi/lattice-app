import React, { useState } from 'react';
import { Check, Eye, EyeOff, Loader2, Trash2 } from 'lucide-react';

interface SecretKeyFieldProps {
  id: string;
  label: string;
  hint?: string;
  placeholder: string;
  /** Whether a key is saved on the server. The key itself is never sent to the page. */
  configured: boolean;
  /** A string replaces the saved key; null removes it. */
  onSave: (value: string | null) => Promise<void>;
}

/**
 * An API key the page can set but never read back. Saved: "Key saved" with
 * Replace and Remove. Not saved, or replacing: a password field and Save.
 */
export function SecretKeyField({ id, label, hint, placeholder, configured, onSave }: SecretKeyFieldProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
      setValue('');
      setShow(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key');
    } finally {
      setBusy(false);
    }
  };

  const showInput = editing || !configured;

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-xs font-medium text-fg-2 flex items-center gap-2">
        {label}
        {hint && <span className="text-xs text-fg-3">{hint}</span>}
      </label>
      {showInput ? (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              id={id}
              type={show ? 'text' : 'password'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) void save(value); }}
              placeholder={placeholder}
              autoComplete="off"
              disabled={busy}
              className="w-full px-3 py-2 pr-10 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg placeholder:text-fg-3 focus:outline-none focus:border-accent disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setShow(!show)}
              aria-label={show ? 'Hide key' : 'Show key'}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-3 hover:text-fg transition-colors cursor-pointer"
            >
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button
            type="button"
            onClick={() => void save(value)}
            disabled={busy || !value.trim()}
            className="px-3 py-2 rounded-md text-[13px] font-medium text-accent hover:bg-accent-soft transition-colors cursor-pointer disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
          </button>
          {editing && (
            <button
              type="button"
              onClick={() => { setEditing(false); setValue(''); setError(null); }}
              disabled={busy}
              className="ui-action-btn px-3 py-2 text-[13px] cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2 px-3 py-2 text-xs text-fg-2 bg-bg border border-line-2 rounded-md flex-1" data-testid={`${id}-saved`}>
            <Check size={14} className="text-emerald-400" />
            Key saved
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            className="ui-action-btn px-3 py-2 text-[13px] cursor-pointer disabled:opacity-50"
          >
            Replace
          </button>
          <button
            type="button"
            onClick={() => void save(null)}
            disabled={busy}
            aria-label={`Remove ${label}`}
            className="ui-action-btn ui-action-btn--rose flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            <span>Remove</span>
          </button>
        </div>
      )}
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </div>
  );
}
