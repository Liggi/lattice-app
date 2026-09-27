import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { api } from '../../services/api';
import { ApiRequestError } from '../../services/api/core';
import { useFeedbackStatus, useInvalidateFeedback } from '../../hooks/useFeedback';
import type { FeedbackCategory, FeedbackPayload, FeedbackRegistration } from '@/types/feedback';

export const CATEGORIES: Array<[FeedbackCategory, string]> = [
  ['bug', 'Bug'],
  ['suggestion', 'Suggestion'],
  ['other', 'Other'],
];

export const QUIET_BTN = 'px-2.5 py-1.5 rounded-md text-[13px] text-fg-3 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-50';
export const PRIMARY_BTN = 'flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent-soft text-accent text-[13px] font-medium hover:bg-accent/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

const CHECK_BTN = 'ui-action-btn px-3 py-1.5 text-[13px] cursor-pointer';

/** The server answers this when the install has no key, or the collector stopped accepting it. */
export function needsCheck(err: unknown): boolean {
  return err instanceof ApiRequestError && err.code === 'verification_required';
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The collector's bot check, framed here so every Lattice origin works
 * without being registered with the anti-bot service. It posts back a ticket
 * for this install, which the server trades for the install's key.
 */
function CheckPanel({ registration, onTicket, onError }: {
  registration: FeedbackRegistration;
  onTicket: (ticket: string) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(90);
  useEffect(() => {
    frameRef.current?.scrollIntoView({ block: 'nearest' });
  }, [height]);
  const nonce = useMemo(() => randomNonce(), []);
  const origin = registration.collectorOrigin;
  const src = useMemo(() => {
    const params = new URLSearchParams({
      purpose: 'install',
      nonce,
      install_id: registration.installId,
      parent_origin: window.location.origin,
      // Lattice is always dark; a scheme differing from the parent's makes Chrome paint the frame opaque.
      theme: 'dark',
    });
    return `${origin}/v1/verify?${params.toString()}`;
  }, [nonce, registration.installId, origin]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; nonce?: unknown; ticket?: unknown; height?: unknown; message?: unknown };
      if (!data || data.nonce !== nonce) return;
      if (data.type === 'lattice-feedback-ticket' && typeof data.ticket === 'string') onTicket(data.ticket);
      else if (data.type === 'lattice-feedback-verify-resize' && typeof data.height === 'number') setHeight(Math.min(Math.max(data.height, 40), 600));
      else if (data.type === 'lattice-feedback-verify-error') onError(typeof data.message === 'string' ? data.message : 'The check failed.');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, nonce, onTicket, onError]);

  return (
    <iframe
      ref={frameRef}
      src={src}
      title="Feedback check"
      referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      // The panel pads its widget by 8px; pull it back in line with the text.
      className="-ml-2 w-[calc(100%+0.5rem)]"
      style={{ height, colorScheme: 'dark' }}
      data-testid="feedback-check-panel"
    />
  );
}

/**
 * The one-time check, run inside the first Send, or again if the collector
 * stops accepting this install's key. Passing it lets the send go ahead.
 */
export function FeedbackCheck({ onDone, onCancel }: {
  onDone: () => void;
  onCancel?: () => void;
}): JSX.Element {
  const invalidate = useInvalidateFeedback();
  const again = useFeedbackStatus()?.registered === true;
  const [registration, setRegistration] = useState<FeedbackRegistration | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getFeedbackRegistration()
      .then((result) => { if (!cancelled) setRegistration(result); })
      .catch((err: unknown) => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, []);

  const onTicket = useCallback((ticket: string) => {
    setRegistering(true);
    setError(null);
    api.registerFeedback(ticket)
      .then(async () => {
        await invalidate();
        onDone();
      })
      .catch((err: unknown) => {
        setError(errorText(err));
        setRegistering(false);
      });
  }, [invalidate, onDone]);

  const onError = useCallback((message: string) => setError(message), []);

  return (
    <div className="space-y-2" data-testid="feedback-check">
      <p className="text-xs text-fg-2">
        {again
          ? 'The feedback service asks you to confirm again, then this sends.'
          : "Confirm you're human to send. You'll only be asked once."}
      </p>
      {registering ? (
        <span className="flex items-center gap-2 text-xs text-fg-3">
          <Loader2 size={14} className="animate-spin" />
          Checked. Sending
        </span>
      ) : registration && !error ? (
        <CheckPanel key={attempt} registration={registration} onTicket={onTicket} onError={onError} />
      ) : !error ? (
        <Loader2 size={14} className="animate-spin text-fg-3" />
      ) : null}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {((error && registration) || (onCancel && !registering)) && (
        <div className="flex flex-wrap items-center gap-2">
          {error && registration && (
            <button onClick={() => { setError(null); setAttempt((n) => n + 1); }} className={CHECK_BTN}>Check again</button>
          )}
          {onCancel && !registering && <button onClick={onCancel} className={QUIET_BTN}>Cancel</button>}
        </div>
      )}
    </div>
  );
}

/** One row of "what is sent": a plain label and its exact value; ids and addresses in the data face. */
function SentRow({ label, children, note, data = false }: { label: string; children: ReactNode; note?: string; data?: boolean }): JSX.Element {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-x-3 py-0.5">
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="min-w-0 text-xs text-fg-2">
        <span className={data ? 'font-mono [overflow-wrap:anywhere]' : ''}>{children}</span>
        {note && <span className="block text-fg-3">{note}</span>}
      </dd>
    </div>
  );
}

/** A URL that wraps only after its dots and slashes, never inside a name. */
function Address({ url }: { url: string }): JSX.Element {
  const parts = url.split(/(?<=[./])(?=[^./])/);
  return <>{parts.map((part, i) => <span key={i} className="whitespace-nowrap">{part}{i < parts.length - 1 && <wbr />}</span>)}</>;
}

/** The quiet row that opens "what is sent"; the chat card and the form share it. */
export function WhatIsSentToggle({ open, onToggle }: { open: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex items-center gap-0.5 text-xs font-medium text-fg-3 hover:text-fg cursor-pointer"
      data-testid="feedback-what-is-sent"
    >
      What is sent
      <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
    </button>
  );
}

/** Every field that goes with the message, exactly as it will be sent. */
export function SentFields({ fields, fromAgent, destination }: {
  fields: Pick<FeedbackPayload, 'scope' | 'session_ref' | 'provider' | 'model' | 'lattice_version' | 'screen' | 'install_id'>;
  fromAgent: boolean;
  destination: string;
}): JSX.Element {
  const session = fields.scope === 'session';
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-fg-3">Only the message, its kind and these details; no conversation, files or settings.</p>
      <dl data-testid="feedback-sent-fields">
        <SentRow label="From">{fromAgent ? 'An agent, sent by you' : 'You'}</SentRow>
        {session ? (
          <SentRow label="About" data note="A random reference to this session; its content is not sent.">{fields.session_ref ?? ''}</SentRow>
        ) : (
          <SentRow label="About">Lattice in general</SentRow>
        )}
        {fields.provider && <SentRow label="Provider">{fields.provider}</SentRow>}
        {fields.model && <SentRow label="Model" data>{fields.model}</SentRow>}
        <SentRow label="Lattice version" data>{fields.lattice_version}</SentRow>
        <SentRow label="Screen">{fields.screen}</SentRow>
        <SentRow label="Install ID" data note="Random; links your messages, not you.">{fields.install_id}</SentRow>
        <SentRow label="Sent to" data><Address url={destination} /></SentRow>
      </dl>
      <p className="text-xs text-fg-3">Kept for 90 days. Your IP address is not stored with it.</p>
    </div>
  );
}
