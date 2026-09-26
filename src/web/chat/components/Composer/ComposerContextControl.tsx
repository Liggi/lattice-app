import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, Loader2 } from 'lucide-react';
import type { ContextCompactionData, TurnUsage } from '@liggi/agent-ui-harness/protocol';

const POPOVER_WIDTH_PX = 280;
const VIEWPORT_MARGIN_PX = 12;
const TOUCH_TARGET_44 =
  "relative before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:min-w-11 "
  + "before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

interface ComposerContextControlProps {
  usage: TurnUsage | null;
  compaction: ContextCompactionData | null;
  canCompact: boolean;
  onCompact: () => Promise<void>;
}

function contextTokens(usage: TurnUsage): number {
  return usage.contextTokens
    ?? usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function formatExactTokens(tokens: number): string {
  return new Intl.NumberFormat().format(tokens);
}

export function ComposerContextControl({
  usage,
  compaction,
  canCompact,
  onCompact,
}: ComposerContextControlProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const isCompacting = requesting || compaction?.phase === 'started';
  const providerError = compaction?.phase === 'failed' ? compaction.error ?? 'Compaction failed.' : null;
  const error = requestError ?? providerError;

  useEffect(() => {
    if (compaction?.phase === 'completed' || compaction?.phase === 'failed') {
      setRequesting(false);
    }
  }, [compaction]);

  const toggle = useCallback(() => {
    setOpen((previous) => {
      if (previous) return false;
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setAnchor({ top: rect.top, left: rect.left + rect.width / 2 });
      return true;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest?.('[data-context-ui="true"]')) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  const handleCompact = useCallback(async () => {
    if (!canCompact || isCompacting) return;
    setRequestError(null);
    setRequesting(true);
    try {
      await onCompact();
    } catch (compactError) {
      setRequesting(false);
      setRequestError(compactError instanceof Error ? compactError.message : String(compactError));
    }
  }, [canCompact, isCompacting, onCompact]);

  // The composer's own status bar already announces "Compacting context" a few
  // pixels to the left, so this control does not repeat the word — it keeps
  // showing the token count and only changes tone. With no usage yet there is
  // nothing for it to say, compacting or not.
  if (!usage) return null;

  const tokens = usage ? contextTokens(usage) : null;
  const tokenTone = isCompacting
    ? 'text-amber-400'
    : error
      ? 'text-rose-300'
      : 'text-fg-2 hover:text-fg';

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768;
  const width = Math.min(POPOVER_WIDTH_PX, viewportWidth - 2 * VIEWPORT_MARGIN_PX);
  const left = anchor
    ? Math.min(
      Math.max(anchor.left - width / 2, VIEWPORT_MARGIN_PX),
      Math.max(VIEWPORT_MARGIN_PX, viewportWidth - width - VIEWPORT_MARGIN_PX),
    )
    : VIEWPORT_MARGIN_PX;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-context-ui="true"
        data-testid="token-usage"
        data-context-control="true"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Open context details"
        title="Context details"
        onClick={toggle}
        className={`${TOUCH_TARGET_44} flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition-colors cursor-pointer hover:bg-surface-2 ${tokenTone}`}
        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
      >
        <Gauge size={12} className="shrink-0" />
        <span
          className="whitespace-nowrap tabular-nums"
          data-tokens={tokens ?? undefined}
        >
          {formatTokenCount(tokens ?? 0)}
          <span className="hidden sm:inline"> tokens</span>
        </span>
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          data-context-ui="true"
          data-testid="context-details-popover"
          role="dialog"
          aria-label="Context details"
          className="fixed z-50 overflow-hidden rounded-lg border border-line bg-surface"
          style={{
            bottom: Math.max(VIEWPORT_MARGIN_PX, viewportHeight - (anchor?.top ?? viewportHeight) + 8),
            left,
            width,
            touchAction: 'manipulation',
          }}
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Gauge size={12} className="text-fg-3" />
            <span className="text-xs font-medium text-fg-2">
              Context
            </span>
          </div>
          <div className="space-y-2 px-3 py-3">
            {tokens !== null && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-fg-2">Current context</span>
                <span className="text-[13px] tabular-nums text-fg">
                  {formatExactTokens(tokens)} tokens
                </span>
              </div>
            )}
            {usage && (
              <div className="space-y-1 border-t border-line pt-2">
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-fg-3">Uncached input</span>
                  <span className="tabular-nums text-fg-2">
                    {formatExactTokens(usage.inputTokens)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-fg-3">Cache read</span>
                  <span className="tabular-nums text-fg-2">
                    {formatExactTokens(usage.cacheReadInputTokens)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-fg-3">Cache write</span>
                  <span className="tabular-nums text-fg-2">
                    {formatExactTokens(usage.cacheCreationInputTokens)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-fg-3">Last output</span>
                  <span className="tabular-nums text-fg-2">
                    {formatExactTokens(usage.outputTokens)}
                  </span>
                </div>
              </div>
            )}
            <p className="text-xs leading-relaxed text-fg-3">
              Compaction summarizes older context while preserving the thread and current work.
            </p>
            {error && (
              <div data-testid="context-compaction-error" className="rounded-sm bg-[rgb(var(--color-rose-rgb)/0.1)] px-2 py-1.5 text-xs leading-snug text-rose-300">
                {error}
              </div>
            )}
          </div>
          <div className="flex items-center justify-end border-t border-line px-2 py-2">
            <button
              type="button"
              data-testid="compact-now-button"
              onClick={() => void handleCompact()}
              disabled={!canCompact || isCompacting}
              className="flex min-h-8 items-center gap-1.5 rounded-sm bg-surface-2 px-3 text-[13px] font-medium text-fg transition-colors hover:bg-line-2 disabled:cursor-not-allowed disabled:opacity-45"
              title={!canCompact ? 'Wait for the current turn to finish' : 'Compact context now'}
            >
              {isCompacting && <Loader2 size={11} className="animate-spin" />}
              {isCompacting ? 'Compacting…' : 'Compact now'}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
