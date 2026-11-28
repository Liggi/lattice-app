/**
 * What one Inbox item says and what can be done about it, shared by the
 * desktop detail pane and a phone row opened in place: cold-read context
 * bullets, an optional inline artifact (editable draft message, aligned
 * comparison table, text or visual previews), unified option/recommendation
 * cards with one-click acceptance, a quiet consequence line when unanswered,
 * and consistent escape hatches. An answer is held for a few seconds before
 * it goes (`held-replies.ts`), so each one shows with Undo until the feed
 * drops the item.
 */

import { type JSX, useEffect, useState } from 'react';
import {
  ArrowUp,
  ArrowUpRight,
  CircleHelp,
  Clock3,
  CornerDownLeft,
  ExternalLink,
  Eye,
  GitFork,
  GitPullRequest,
  KeyRound,
  Pencil,
  Play,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { InboxArtifact, InboxItem } from '@/types/inbox-feed';
import { parseAsk } from '@/types/ask-text';
import { StateGlyph } from '../shared/StateGlyph';
import { holdReply, threadAction, undoReply } from '../InsightsPanel/YourCalls';
import { AskAnswers, AskWords } from '../InsightsPanel/AskAnswers';
import { api } from '../../services/api';
import { inboxGlyph, jobCount, prRef, requestKindOf, singleAskRecommendation } from './inbox-view';

/** What happened to an item the user acted on, until the feed catches up. */
export type InboxOutcome =
  | { state: 'held'; label: string; undo: (() => Promise<void>) | null }
  | { state: 'error'; message: string };

/** Runs an action and records its outcome; `perform` returns how to take it back, or null. */
export type RunAction = (item: InboxItem, label: string, perform: () => Promise<(() => Promise<void>) | null>) => Promise<void>;

/** Distinct semantic icon per request kind or operational state — never one generic dot stamped on every row. */
export function KindMark({ item, answered = false, size = 13, neutralPr = false }: { item: InboxItem; answered?: boolean; size?: number; neutralPr?: boolean }): JSX.Element {
  if (answered) return <StateGlyph kind="done" size={size} />;
  if (item.kind === 'failing-pr' && neutralPr) {
    return <GitPullRequest size={size} strokeWidth={1.75} className="shrink-0 text-fg-2" aria-hidden="true" />;
  }
  if (item.kind === 'failed-run' || item.kind === 'failing-pr') {
    return <StateGlyph kind="failed" size={size} />;
  }
  if (item.kind === 'stalled-job') {
    return <StateGlyph kind="waiting" size={size} className="text-amber-400" />;
  }
  const rk = requestKindOf(item);
  const cls = 'shrink-0 text-fg-2';
  switch (rk) {
    case 'go-ahead':
      return <Play size={Math.max(11, size - 1)} strokeWidth={1.9} className={cls} aria-hidden="true" />;
    case 'decision':
      return <GitFork size={size} strokeWidth={1.75} className={cls} aria-hidden="true" />;
    case 'review':
      return <Eye size={size} strokeWidth={1.75} className={cls} aria-hidden="true" />;
    case 'access':
      return <KeyRound size={size} strokeWidth={1.75} className={cls} aria-hidden="true" />;
    case 'info':
      return <CircleHelp size={size} strokeWidth={1.75} className={cls} aria-hidden="true" />;
    default:
      return <StateGlyph kind={inboxGlyph(item.glyph)} size={size} />;
  }
}

async function retryRun(conversationId: string): Promise<null> {
  const response = await fetch(`/api/conv/${encodeURIComponent(conversationId)}/retry`, { method: 'POST' });
  if (!response.ok) {
    const parsed = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(parsed?.error ?? `HTTP ${response.status}`);
  }
  return null;
}

async function dismissAlert(itemId: string): Promise<() => Promise<void>> {
  const response = await fetch(`/api/inbox/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: itemId }),
  });
  if (!response.ok) {
    const parsed = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(parsed?.error ?? `HTTP ${response.status}`);
  }
  return async () => {
    await fetch(`/api/inbox/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: itemId }),
    });
  };
}

/** The action the Enter key takes on a selected item, or null when it has none worth taking blind. */
export function primaryAction(item: InboxItem, run: RunAction, open: (item: InboxItem) => void): (() => void) | null {
  const action = item.action;
  if (action?.kind === 'decision') {
    const recommended = action.options.find((option) => option.recommended);
    return recommended ? () => void run(item, recommended.label, answerDecision(item, action.decisionId, recommended.label)) : null;
  }
  if (action?.kind === 'thread') {
    const single = singleAskRecommendation(item);
    return single ? () => void run(item, single.recommendation, answerThread(item, action.threadSeq, single.recommendation)) : null;
  }
  if (action?.kind === 'retry') return () => void run(item, 'Retrying', () => retryRun(item.conversationId));
  return () => open(item);
}

function answerDecision(item: InboxItem, decisionId: string, text: string, kind: 'answer' | 'dismiss' = 'answer') {
  return async (): Promise<() => Promise<void>> => {
    const held = await holdReply(item.conversationId, { kind, decision: decisionId }, text);
    return () => undoReply(item.conversationId, held.id);
  };
}

function answerThread(item: InboxItem, seq: number, text: string) {
  return async (): Promise<() => Promise<void>> => {
    const held = await holdReply(item.conversationId, { kind: 'thread', thread: seq }, text);
    return () => undoReply(item.conversationId, held.id);
  };
}

function putAway(item: InboxItem, seq: number, word: 'park' | 'dismiss') {
  return async (): Promise<() => Promise<void>> => {
    await threadAction(item.conversationId, seq, word);
    return () => threadAction(item.conversationId, seq, 'restore');
  };
}

/** The steering message an "Ask project to…" button sends to the project. */
export function nudgeText(item: InboxItem): string | null {
  if (item.kind === 'failing-pr') {
    const ref = prRef(item);
    const checks = ref?.failedChecks.length ? ` (${ref.failedChecks.join(', ')})` : '';
    const which = ref ? `PR #${ref.number} in ${ref.repo}` : 'A pull request';
    return `${which}, "${item.title}", has failing checks${checks}. Please find out what failed and fix it.`;
  }
  if (item.kind === 'stalled-job') {
    return `The job "${item.title}" has ${item.reason === 'Stopped moving' ? `stopped moving${item.detail ? ` at ${item.detail}` : ''}` : `a count Lattice can't read: ${item.detail ?? 'unknown error'}`}. Please check on it.`;
  }
  return null;
}

/** Where the item's own conversation opens, and what to call it. */
export function openTarget(item: InboxItem): { to: string; label: string } {
  const to = item.href?.startsWith('/') ? item.href : `/c/${item.conversationId}`;
  return { to, label: item.kind === 'failed-run' ? 'Open session' : 'Open project' };
}

/** Calm dark-mode primary action button — restrained enough not to shout over the context above it. */
const PRIMARY = 'flex shrink-0 whitespace-nowrap h-9 md:h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface-2 px-3.5 text-[13.5px] font-medium text-fg hover:bg-white/[0.12] disabled:opacity-50 cursor-pointer';
const OUTLINED = 'flex shrink-0 whitespace-nowrap h-9 md:h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13.5px] text-fg-2 hover:border-line-2 hover:text-fg hover:bg-surface/60 disabled:opacity-60 cursor-pointer';
const QUIET = 'flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-fg-3 hover:text-fg-2 disabled:opacity-50 cursor-pointer';
const WHITE_SEND = 'shrink-0 whitespace-nowrap rounded-lg border border-line-2 bg-surface-2 px-3.5 py-1.5 text-[13.5px] font-medium text-fg hover:bg-white/[0.12] disabled:opacity-40 cursor-pointer';
const LINK_AS_BUTTON = { color: 'var(--color-fg)', textDecoration: 'none' } as const;
const ENTER = <CornerDownLeft size={13} className="hidden md:block opacity-50" aria-hidden="true" />;

function Answered({ outcome, onUndo }: { outcome: Extract<InboxOutcome, { state: 'held' }>; onUndo: () => void }): JSX.Element {
  return (
    <span className="flex items-center gap-3 text-[13.5px]" data-testid="inbox-outcome">
      <span className="flex min-w-0 items-center gap-1.5 text-fg/90">
        <StateGlyph kind="done" size={14} className="shrink-0 text-fg-2" />
        <span className="whitespace-pre-line break-words">{outcome.label}</span>
      </span>
      {outcome.undo && <button type="button" onClick={onUndo} className="shrink-0 text-fg-3 hover:text-fg cursor-pointer">Undo</button>}
    </span>
  );
}

/** Cold-read context bullets (preferred) or legacy detail paragraph. */
function ContextBlock({ bullets, fallback }: { bullets?: string[]; fallback?: string | null }): JSX.Element | null {
  const clean = (bullets ?? []).map((b) => b.trim()).filter(Boolean);
  if (clean.length > 0) {
    return (
      <ul
        data-testid="inbox-context"
        className="list-disc space-y-1.5 pl-4 text-[14px] leading-[1.55] text-fg-2 marker:text-fg-3/60 break-words"
      >
        {clean.map((line, idx) => (
          <li key={idx} className="pl-0.5">{line}</li>
        ))}
      </ul>
    );
  }
  const text = fallback?.trim();
  if (!text) return null;
  return (
    <p className="whitespace-pre-wrap text-[14px] leading-[1.55] text-fg-2 break-words" data-testid="inbox-context">
      {text}
    </p>
  );
}

/** Compact aligned metric deltas so numbers never get buried in prose bullets. */
function MetricsBlock({ metrics }: { metrics?: InboxItem['metrics'] }): JSX.Element | null {
  if (!metrics || metrics.length === 0) return null;
  return (
    <dl className="flex flex-col gap-1 text-[13px] tabular-nums" data-testid="inbox-metrics">
      {metrics.map((row) => {
        const tone = row.tone === 'worse'
          ? 'text-rose-400'
          : row.tone === 'better'
            ? 'text-emerald-400'
            : 'text-fg-3';
        return (
          <div key={row.label} className="flex items-baseline justify-between gap-4 border-b border-line/40 py-1 last:border-b-0">
            <dt className="min-w-0 truncate text-fg-2">{row.label}</dt>
            <dd className={`shrink-0 font-mono text-[12.5px] ${tone}`}>{row.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * Inline draft, comparison table, text snippet or visual preview so the user
 * never has to jump to chat to see what they are judging. Soft surface without
 * heavy nested divider bars; outgoing drafts support inline editing.
 */
function ArtifactBlock({
  artifact,
  draftValue,
  onDraftChange,
}: {
  artifact: InboxArtifact;
  draftValue?: string;
  onDraftChange?: (next: string) => void;
}): JSX.Element {
  const [zoomed, setZoomed] = useState<{ src: string; caption?: string } | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomed(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed]);

  const bodyText = draftValue ?? artifact.body ?? '';
  const canEdit = Boolean(artifact.editable && onDraftChange);

  return (
    <>
      <div className="rounded-lg bg-surface/65 px-3.5 py-3" data-testid="inbox-artifact">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pb-2">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="text-[12.5px] font-medium text-fg-2">{artifact.label}</span>
            {artifact.meta && <span className="truncate text-[12px] text-fg-3">{artifact.meta}</span>}
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-fg-3 hover:text-fg cursor-pointer"
            >
              <Pencil size={11} aria-hidden="true" />
              <span>{editing ? 'Done' : 'Edit'}</span>
            </button>
          )}
        </div>

        {artifact.body !== undefined && (
          editing && canEdit ? (
            <textarea
              rows={4}
              value={bodyText}
              onChange={(e) => onDraftChange?.(e.target.value)}
              aria-label={`Edit ${artifact.label}`}
              className="w-full resize-y rounded-md border border-line-2 bg-bg/70 px-3 py-2 text-[13.5px] leading-[1.6] text-fg outline-none focus:border-fg-3"
            />
          ) : (
            <div className="text-[13.5px] leading-[1.6] text-fg whitespace-pre-wrap break-words">
              {bodyText}
            </div>
          )
        )}

        {artifact.table && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px] tabular-nums">
              <thead>
                <tr className="border-b border-line/70 text-[12px] text-fg-3">
                  <th className="py-1.5 pr-4 text-left font-normal">Option</th>
                  {artifact.table.columns.map((col) => (
                    <th key={col} className="py-1.5 pl-4 text-right font-normal whitespace-nowrap">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {artifact.table.rows.map((row, idx) => (
                  <tr key={row.label} className={idx > 0 ? 'border-t border-line/40' : undefined}>
                    <td className="py-2 pr-4 text-left font-medium text-fg whitespace-nowrap">{row.label}</td>
                    {row.values.map((val, j) => (
                      <td key={j} className="py-2 pl-4 text-right text-fg-2 whitespace-nowrap">{val}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {artifact.images && artifact.images.length > 0 && (
          <div className={`grid gap-3 pt-0.5 ${artifact.images.length > 1 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
            {artifact.images.map((img, i) => (
              <figure key={i} className="flex flex-col gap-1.5">
                <button
                  type="button"
                  onClick={() => setZoomed(img)}
                  title="Click to inspect full size"
                  className="group block overflow-hidden rounded-md border border-line/70 bg-bg text-left transition-colors hover:border-line-2 cursor-pointer"
                >
                  <img
                    src={img.src}
                    alt={img.caption ?? artifact.label}
                    className={`w-full bg-bg object-contain ${artifact.images && artifact.images.length > 1 ? 'aspect-[3/2]' : 'max-h-72'}`}
                  />
                </button>
                {img.caption && <figcaption className="text-[12px] text-fg-3">{img.caption}</figcaption>}
              </figure>
            ))}
          </div>
        )}
      </div>
      {zoomed && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={zoomed.caption ?? artifact.label}
          onClick={() => setZoomed(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
        >
          <div className="flex max-h-full max-w-5xl flex-col gap-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-4 text-[13px] text-fg-2">
              <span>{zoomed.caption ?? artifact.label}</span>
              <button type="button" onClick={() => setZoomed(null)} className="rounded-md p-1 text-fg-3 hover:text-fg cursor-pointer" aria-label="Close preview">
                <X size={16} />
              </button>
            </div>
            <img src={zoomed.src} alt={zoomed.caption ?? artifact.label} className="max-h-[82vh] w-auto rounded-lg border border-line-2 object-contain" />
          </div>
        </div>
      )}
    </>
  );
}

/** Quiet unboxed footer for consequence-if-unanswered (only when a real timer or side-effect exists) plus escape hatches. */
function StakesFooter({
  ifUnanswered,
  controls,
}: {
  ifUnanswered?: string | null;
  controls?: JSX.Element | null;
}): JSX.Element | null {
  if (!ifUnanswered && !controls) return null;
  return (
    <div className="flex flex-col gap-2.5 border-t border-line/60 pt-3.5" data-testid="inbox-stakes">
      {ifUnanswered && (
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[12.5px] leading-[1.5]">
          <span className="shrink-0 text-fg-3">If unanswered</span>
          <span className="text-fg-2 break-words">{ifUnanswered}</span>
        </div>
      )}
      {controls && <div className="-ml-2 flex flex-wrap items-center gap-1">{controls}</div>}
    </div>
  );
}

/** A failure in rose, a stall in amber: left-aligned to the shared edge with the heading and context. */
function Status({ item }: { item: InboxItem }): JSX.Element | null {
  if (item.kind === 'failing-pr') {
    const checks = prRef(item)?.failedChecks ?? [];
    return (
      <div data-testid="inbox-status">
        <div className="flex items-center gap-2 text-[14px] text-rose-400"><StateGlyph kind="failed" size={14} />{item.reason}</div>
        {checks.length > 0 && (
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5 pt-2" aria-label="Failed checks">
            {checks.map((name) => (
              <li key={name} className="flex min-w-0 items-center gap-1.5 font-mono text-[12.5px] text-fg-2">
                <X size={12} strokeWidth={2.25} className="shrink-0 text-rose-400/80" aria-hidden="true" />
                <span className="break-all">{name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (item.kind === 'failed-run' && item.action?.kind === 'retry') {
    return (
      <div data-testid="inbox-status">
        <div className="flex items-center gap-2 text-[14px] text-rose-400"><StateGlyph kind="failed" size={14} />{item.reason}</div>
        <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-fg-2">{item.action.errorMessage}</pre>
      </div>
    );
  }
  if (item.kind === 'stalled-job') {
    const count = jobCount(item);
    return (
      <div data-testid="inbox-status" className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[14px] text-amber-400"><StateGlyph kind="waiting" size={14} className="text-amber-400" />{item.reason}</div>
        {count ? (
          <div className="flex items-center gap-3">
            <span className="h-1 w-40 overflow-hidden rounded-full bg-surface-2"><span className="block h-full rounded-full bg-amber-400/70" style={{ width: `${Math.min(100, (count.done / count.total) * 100)}%` }} /></span>
            <span className="text-[13px] tabular-nums text-fg-2">{count.done.toLocaleString()} of {count.total.toLocaleString()}</span>
          </div>
        ) : item.detail && <p className="font-mono text-[12.5px] text-fg-2 break-words">{item.detail}</p>}
      </div>
    );
  }
  return null;
}

/** Sends the project a steering message, then clears the alert as Dismiss does; Undo brings the card back but cannot unsend. */
function nudgeAndDismiss(item: InboxItem, message: string) {
  return async (): Promise<() => Promise<void>> => {
    await api.resumeConversation(item.conversationId, { message });
    return dismissAlert(item.id);
  };
}

/** One button that sends the project a steering message and clears the card. */
function NudgeButton({ item, label, primary, busy, go }: {
  item: InboxItem;
  label: string;
  primary?: boolean;
  busy: boolean;
  go: (label: string, perform: () => Promise<(() => Promise<void>) | null>) => () => Promise<void>;
}): JSX.Element | null {
  const message = nudgeText(item);
  if (!message) return null;
  return (
    <button
      type="button"
      title={message}
      disabled={busy}
      onClick={go(`Sent to ${item.projectTitle}`, nudgeAndDismiss(item, message))}
      className={primary ? PRIMARY : OUTLINED}
    >
      {label}
    </button>
  );
}

/**
 * Everything under an item's heading: cold-read context, inline artifact,
 * unified option cards or one-click recommendation card, reply input, and
 * quiet consequence/escape-hatch footer. `compact` is a phone row opened in
 * place, which carries its own top Open link.
 */
export function InboxBody({ item, outcome, run, onUndo, compact = false }: {
  item: InboxItem;
  outcome: InboxOutcome | undefined;
  run: RunAction;
  onUndo: (item: InboxItem) => void;
  compact?: boolean;
}): JSX.Element {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [draftText, setDraftText] = useState<string | undefined>(item.artifact?.body);
  const held = outcome?.state === 'held' ? outcome : null;
  const error = outcome?.state === 'error' ? <p className="text-[12.5px] text-rose-400">{outcome.message}</p> : null;
  const go = (label: string, perform: () => Promise<(() => Promise<void>) | null>) => async () => {
    setBusy(true);
    try { await run(item, label, perform); } finally { setBusy(false); }
  };
  const target = openTarget(item);
  const openLink = compact && (
    <div className="flex items-center justify-between gap-2 pb-1 text-[12.5px] text-fg-3">
      {item.priorityReason ? <span className="truncate">{item.priorityReason}</span> : <span />}
      <button type="button" onClick={() => void navigate(target.to)} className="inline-flex shrink-0 items-center gap-1 text-fg-3 hover:text-fg cursor-pointer">
        {target.label}<ArrowUpRight size={13} aria-hidden="true" />
      </button>
    </div>
  );
  const answered = held && <Answered outcome={held} onUndo={() => onUndo(item)} />;
  const gap = compact ? 'gap-3.5' : 'gap-4';
  const action = item.action;

  if (action?.kind === 'decision') {
    const draftEdited = Boolean(item.artifact?.editable && draftText !== undefined && draftText !== item.artifact.body);
    const controls = !held ? (
      <>
        {action.canPark && action.threadSeq !== undefined && (
          <button
            type="button"
            disabled={busy}
            title="Move to project backlog without cancelling"
            onClick={go('Parked', putAway(item, action.threadSeq, 'park'))}
            className={QUIET}
          >
            <Clock3 size={13} strokeWidth={1.75} aria-hidden="true" />Park
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          title="Decline to answer this question and tell the project"
          onClick={go('Dismissed', answerDecision(item, action.decisionId, '', 'dismiss'))}
          className={QUIET}
        >
          <X size={13} strokeWidth={1.75} aria-hidden="true" />Dismiss
        </button>
      </>
    ) : null;

    return (
      <div className={`flex flex-col ${gap}`} data-testid="inbox-body">
        {openLink}
        <ContextBlock bullets={item.context} fallback={item.detail} />
        <MetricsBlock metrics={item.metrics} />
        {item.artifact && (
          <ArtifactBlock
            artifact={item.artifact}
            draftValue={draftText}
            onDraftChange={item.artifact.editable ? setDraftText : undefined}
          />
        )}
        {answered || (
          <div className="flex flex-col gap-2" role="group" aria-label="Options">
            {action.options.map((option, idx) => {
              const carriesEdit = Boolean(draftEdited && draftText && (option.recommended || (!action.options.some((o) => o.recommended) && idx === 0)));
              const replyPayload = carriesEdit
                ? `${option.label}\n\nEdited draft:\n${draftText}`
                : option.label;
              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={busy}
                  data-testid="inbox-option"
                  onClick={go(option.label, answerDecision(item, action.decisionId, replyPayload))}
                  className={`flex w-full items-start gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors disabled:opacity-60 cursor-pointer ${
                    option.recommended
                      ? 'border-line-2 bg-surface/90 hover:bg-surface'
                      : 'border-line/80 hover:border-line-2 hover:bg-surface/50'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium leading-snug text-fg break-words">
                      {carriesEdit ? `${option.label} (edited)` : option.label}
                    </span>
                    {option.description && <span className="block pt-0.5 text-[13px] leading-[1.45] text-fg-2 break-words">{option.description}</span>}
                  </span>
                  {option.recommended && (
                    <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[12px] text-fg-2">Recommended{ENTER}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {error}
        {!held && <InboxReply item={item} run={run} placeholder={`Answer ${item.projectTitle} in your own words…`} />}
        <StakesFooter ifUnanswered={item.ifUnanswered} controls={controls} />
      </div>
    );
  }

  if (action?.kind === 'thread') {
    const single = singleAskRecommendation(item);
    const ask = !single && action.askText ? parseAsk(action.askText) : null;
    const send = (text: string) => void go(text, answerThread(item, action.threadSeq, text))();
    const controls = !held && (action.canPark || action.canDismiss) ? (
      <>
        {action.canPark && (
          <button
            type="button"
            disabled={busy}
            title="Move to project backlog without stopping work"
            onClick={go('Parked', putAway(item, action.threadSeq, 'park'))}
            className={QUIET}
          >
            <Clock3 size={13} strokeWidth={1.75} aria-hidden="true" />Park
          </button>
        )}
        {action.canDismiss && (
          <button
            type="button"
            disabled={busy}
            title="Close this thread and stop any worker on it"
            onClick={go('Dismissed', putAway(item, action.threadSeq, 'dismiss'))}
            className={QUIET}
          >
            <X size={13} strokeWidth={1.75} aria-hidden="true" />Dismiss
          </button>
        )}
      </>
    ) : null;

    // Single-question ask with a recommendation: unified calm option card (same chrome as Go-ahead / Decision).
    if (single) {
      return (
        <div className={`flex flex-col ${gap}`} data-testid="inbox-body">
          {openLink}
          <ContextBlock bullets={item.context} fallback={item.detail ?? single.context} />
          {item.artifact && <ArtifactBlock artifact={item.artifact} />}
          {answered || (
            <div className="flex flex-col gap-3">
              <button
                type="button"
                disabled={busy}
                data-testid="inbox-accept-rec"
                onClick={go(single.recommendation, answerThread(item, action.threadSeq, single.recommendation))}
                className="flex w-full items-start gap-3 rounded-lg border border-line-2 bg-surface/90 px-3.5 py-2.5 text-left transition-colors hover:bg-surface disabled:opacity-60 cursor-pointer"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium leading-snug text-fg break-words">{single.recommendation}</span>
                  {single.question.trim().toLowerCase() !== action.question.trim().toLowerCase() && (
                    <span className="block pt-0.5 text-[13px] leading-[1.45] text-fg-2 break-words">{single.question}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[12px] text-fg-2">Recommended{ENTER}</span>
              </button>
              <InboxReply item={item} run={run} placeholder={`Or reply to ${item.projectTitle} in your own words…`} />
            </div>
          )}
          {error}
          <StakesFooter ifUnanswered={item.ifUnanswered} controls={controls} />
        </div>
      );
    }

    // Multi-question ask (2+ numbered questions) or unstructured Access/Info/Review ask.
    const multiAsk = ask && ask.questions.length >= 2 ? ask : null;
    const inlineFooter = !item.ifUnanswered ? controls : undefined;
    return (
      <div className={`flex flex-col ${gap}`} data-testid="inbox-body">
        {openLink}
        <ContextBlock bullets={item.context} fallback={item.detail} />
        {item.artifact && <ArtifactBlock artifact={item.artifact} />}
        {answered || (multiAsk
          ? <AskAnswers ask={item.context?.length ? { ...multiAsk, context: '' } : multiAsk} sending={busy} onSend={send} footer={inlineFooter} sendClassName={WHITE_SEND} />
          : <AskWords text={action.askText ?? ''} sending={busy} onSend={send} footer={inlineFooter} sendClassName={WHITE_SEND} placeholder={`Answer ${item.projectTitle}…`} />)}
        {error}
        {item.ifUnanswered && <StakesFooter ifUnanswered={item.ifUnanswered} controls={controls} />}
      </div>
    );
  }

  // A failing PR, a failed run or a stalled job: its status, context, what to do, and Dismiss.
  let buttons: JSX.Element;
  if (action?.kind === 'retry') {
    buttons = <button type="button" disabled={busy} onClick={go('Retrying', () => retryRun(item.conversationId))} className={PRIMARY}>Retry{ENTER}</button>;
  } else if (item.kind === 'failing-pr' && item.href) {
    buttons = (
      <>
        <a href={item.href} target="_blank" rel="noreferrer" className={PRIMARY} style={LINK_AS_BUTTON}>Open PR<ExternalLink size={13} className="opacity-60" aria-hidden="true" /></a>
        <NudgeButton item={item} label="Ask project to fix" busy={busy} go={go} />
      </>
    );
  } else {
    buttons = <NudgeButton item={item} label="Ask project to check" primary busy={busy} go={go} />;
  }

  const alertControls = !held ? (
    <button
      type="button"
      disabled={busy}
      title="Clear this alert from Inbox until its status changes"
      onClick={go('Dismissed', () => dismissAlert(item.id))}
      className={QUIET}
    >
      <X size={13} strokeWidth={1.75} aria-hidden="true" />Dismiss
    </button>
  ) : null;

  return (
    <div className={`flex flex-col ${gap}`} data-testid="inbox-body">
      {openLink}
      {!(compact && item.kind === 'failing-pr') && <Status item={item} />}
      <ContextBlock bullets={item.context} fallback={item.kind === 'stalled-job' ? null : item.detail} />
      <div className="flex flex-wrap items-center gap-2" data-testid="inbox-actions">
        {answered || buttons}
      </div>
      {error}
      {!held && <InboxReply item={item} run={run} placeholder={`Message ${item.projectTitle}…`} />}
      <StakesFooter ifUnanswered={item.ifUnanswered} controls={alertControls} />
    </div>
  );
}

/** Where a typed reply goes: the card or thread it answers, held with Undo, or else the conversation itself. */
export function replyPerformer(item: InboxItem, text: string): (() => Promise<(() => Promise<void>) | null>) | null {
  const action = item.action;
  if (action?.kind === 'decision') return answerDecision(item, action.decisionId, text);
  if (action?.kind === 'thread') return answerThread(item, action.threadSeq, text);
  return null;
}

/** A one-line reply under the item; Enter sends. The placeholder names who reads it. */
export function InboxReply({ item, run, placeholder }: { item: InboxItem; run: RunAction; placeholder: string }): JSX.Element {
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const message = text.trim();
    if (!message || state === 'sending') return;
    const held = replyPerformer(item, message);
    setState('sending');
    setError(null);
    try {
      if (held) {
        // The held reply shows, with Undo, where the item's buttons were.
        await run(item, message, held);
        setState('idle');
      } else {
        await api.resumeConversation(item.conversationId, { message });
        setState('sent');
      }
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  };

  return (
    <div>
      <div className="flex h-10 items-center gap-2 rounded-xl border border-line bg-surface pl-3.5 pr-2 focus-within:border-line-2">
        <input
          value={text}
          onChange={(event) => { setText(event.target.value); if (state !== 'sending') setState('idle'); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder.replace(/…$/, '')}
          data-testid="inbox-reply"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-fg placeholder:text-fg-3 outline-none"
        />
        <button
          type="button"
          aria-label={`Send to ${item.projectTitle}`}
          title={`Send to ${item.projectTitle}`}
          disabled={!text.trim() || state === 'sending'}
          onClick={() => void send()}
          className={`flex size-6.5 shrink-0 items-center justify-center rounded-full cursor-pointer disabled:cursor-default ${text.trim() ? 'bg-fg text-bg' : 'bg-surface-2 text-fg-3'}`}
        >
          <ArrowUp size={13} />
        </button>
      </div>
      {state === 'sent' && <div className="pt-2 text-[12.5px] text-fg-3">Sent to {item.projectTitle}</div>}
      {state === 'error' && error && <div className="pt-2 text-[12.5px] text-rose-400">{error}</div>}
    </div>
  );
}
