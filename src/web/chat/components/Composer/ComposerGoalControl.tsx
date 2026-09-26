import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Pause, Play, Target, Trash2 } from 'lucide-react';

const POPOVER_WIDTH_PX = 340;
const VIEWPORT_MARGIN_PX = 12;
const TOUCH_TARGET_44 =
  "relative before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:min-w-11 "
  + "before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

interface ComposerGoalControlProps {
  placement: 'action' | 'status';
  objective: string;
  status?: 'active' | 'paused' | 'budgetLimited' | 'complete';
  disabled?: boolean;
  onSave: (objective: string) => void | Promise<void>;
  onPause?: () => void | Promise<void>;
  onResume?: () => void | Promise<void>;
  onClear: () => void | Promise<void>;
}

export function ComposerGoalControl({
  placement,
  objective,
  status = 'active',
  disabled = false,
  onSave,
  onPause,
  onResume,
  onClear,
}: ComposerGoalControlProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(objective);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) setDraft(objective);
  }, [objective, open]);

  const toggle = useCallback(() => {
    if (disabled) return;
    setOpen((previous) => {
      if (previous) return false;
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setAnchor({ top: rect.top, left: rect.left + rect.width / 2 });
      setError(null);
      return true;
    });
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest?.('[data-goal-ui="true"]')) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  const runMutation = useCallback(async (mutation: () => void | Promise<void>, close = false) => {
    setSaving(true);
    setError(null);
    try {
      await mutation();
      if (close) setOpen(false);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    } finally {
      setSaving(false);
    }
  }, []);

  const handleSave = useCallback(() => {
    const nextObjective = draft.trim();
    if (!nextObjective || saving) return;
    void runMutation(() => onSave(nextObjective), true);
  }, [draft, onSave, runMutation, saving]);

  const handlePauseResume = useCallback(() => {
    const mutation = status === 'paused' ? onResume : onPause;
    if (!mutation || saving) return;
    void runMutation(mutation);
  }, [onPause, onResume, runMutation, saving, status]);

  const handleClear = useCallback(() => {
    if (saving) return;
    void runMutation(onClear, true);
  }, [onClear, runMutation, saving]);

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768;
  const width = Math.min(POPOVER_WIDTH_PX, viewportWidth - 2 * VIEWPORT_MARGIN_PX);
  const left = anchor
    ? Math.min(
      Math.max(anchor.left - width / 2, VIEWPORT_MARGIN_PX),
      Math.max(VIEWPORT_MARGIN_PX, viewportWidth - width - VIEWPORT_MARGIN_PX),
    )
    : VIEWPORT_MARGIN_PX;

  const hasGoal = objective.trim().length > 0;
  const isPaused = status === 'paused';

  return (
    <>
      {placement === 'action' ? (
        <button
          ref={buttonRef}
          type="button"
          data-goal-ui="true"
          data-testid="goal-action-button"
          onClick={toggle}
          disabled={disabled}
          aria-label="Set goal"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Set a goal for this session"
          className={`${TOUCH_TARGET_44} flex h-[30px] w-[30px] items-center justify-center rounded-full text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45`}
        >
          <Target size={16} />
        </button>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          data-goal-ui="true"
          data-testid="goal-status-badge"
          onClick={toggle}
          disabled={disabled}
          aria-label={isPaused ? 'Goal paused; open goal controls' : 'Open goal controls'}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={objective}
          className={`${TOUCH_TARGET_44} flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-55 ${
            isPaused ? 'text-amber-400/90' : 'text-fg-2 hover:text-fg'
          }`}
        >
          <Target size={12} className="shrink-0" />
          <span className="whitespace-nowrap">
            Goal{isPaused ? ' · Paused' : ''}
          </span>
        </button>
      )}

      {open && typeof document !== 'undefined' && createPortal(
        <div
          data-goal-ui="true"
          data-testid="goal-popover"
          role="dialog"
          aria-label="Goal"
          className="fixed z-50 overflow-hidden rounded-lg border border-line bg-surface"
          style={{
            bottom: Math.max(VIEWPORT_MARGIN_PX, viewportHeight - (anchor?.top ?? viewportHeight) + 8),
            left,
            width,
            touchAction: 'manipulation',
          }}
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Target size={12} className="text-fg-3" />
            <span className="text-xs font-medium text-fg-2">
              Goal
            </span>
            {hasGoal && (
              <span className="ml-auto text-xs text-fg-3">
                {status === 'budgetLimited' ? 'budget reached' : status}
              </span>
            )}
          </div>
          <div className="space-y-2 px-3 py-3">
            <label htmlFor={`composer-goal-${placement}`} className="block text-xs text-fg-3">
              What should the agent keep working toward?
            </label>
            <textarea
              id={`composer-goal-${placement}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={saving}
              rows={3}
              autoFocus
              className="w-full resize-none rounded-sm border border-line-2 bg-bg px-2.5 py-2 text-[13px] leading-relaxed text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none"
              placeholder="Describe the outcome and what counts as done"
            />
            {error && (
              <div className="rounded-sm bg-[rgb(var(--color-rose-rgb)/0.1)] px-2 py-1.5 text-xs text-rose-300">
                {error}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-line px-2 py-2">
            <div className="flex items-center gap-1">
              {hasGoal && (
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={saving}
                  aria-label="Clear goal"
                  title="Clear goal"
                  className="flex h-8 w-8 items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-[rgb(var(--color-rose-rgb)/0.1)] hover:text-rose-300 disabled:opacity-45"
                >
                  <Trash2 size={13} />
                </button>
              )}
              {hasGoal && (onPause || onResume) && status !== 'complete' && (
                <button
                  type="button"
                  onClick={handlePauseResume}
                  disabled={saving}
                  className="flex h-8 items-center gap-1.5 rounded-sm px-2 text-xs text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-45"
                >
                  {isPaused ? <Play size={12} /> : <Pause size={12} />}
                  {isPaused ? 'Resume' : 'Pause'}
                </button>
              )}
            </div>
            <button
              type="button"
              data-testid="goal-save-button"
              onClick={handleSave}
              disabled={!draft.trim() || saving}
              className="flex min-h-8 items-center gap-1.5 rounded-sm bg-surface-2 px-3 text-[13px] font-medium text-fg transition-colors hover:bg-line-2 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {saving && <Loader2 size={11} className="animate-spin" />}
              {hasGoal ? 'Save goal' : 'Set goal'}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
