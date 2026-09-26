import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../Toast/Toast';
import { Check, Copy, SmilePlus } from 'lucide-react';
import {
  AddReactionButton as ToolkitAddReactionButton,
  ReactionChips as ToolkitReactionChips,
  ReactionSheet as ToolkitReactionSheet,
  type ReactionGroup,
  type Reactor,
} from '@liggi/agent-ui-toolkit';
import { copyText } from '../../utils/copy-text';
import { ANNOTATION_TOOLBAR_BUTTON } from '../MessageAnnotations/annotation-styles';

/** What a reaction is on, as the agent will be told it. */
export interface ReactionTarget {
  messageId: string;
  /** The first line of the message, which is how the agent recognises it. */
  excerpt: string;
  /** Set when the message is a worker's report shown in its coordinator's thread. */
  worker?: string;
  /** Set when another session sent the message; the reaction goes to that session. */
  sender?: string;
}

/** What a message offers the touch selection bar: its text to copy, and its reaction target if it takes one. */
interface MessageActionsEntry {
  text: string;
  reaction?: ReactionTarget;
}

interface ReactionsValue {
  reactionsFor: (messageId: string) => readonly string[];
  /** The thread's agent's own reactions on the user's messages (`lattice session react`). */
  agentReactionsFor: (messageId: string) => readonly string[];
  /** Put the user's reaction on (`on`) or take it off. */
  setReaction: (target: ReactionTarget, emoji: string, on: boolean) => void;
  /** Messages on screen, by the `data-message-id` a text selection resolves to. */
  actions: Map<string, MessageActionsEntry>;
  /** Open the reaction sheet for a message (touch). */
  openSheet: (target: ReactionTarget) => void;
}

const NO_REACTIONS: readonly string[] = [];
const NO_MESSAGES: ReadonlyMap<string, readonly string[]> = new Map();
const ReactionsContext = createContext<ReactionsValue | null>(null);

const overlayKey = (messageId: string, emoji: string) => `${messageId}\u0000${emoji}`;

/**
 * The thread's reactions: what its events say, with a click showing at once
 * rather than when its event comes back. A click that fails is taken back
 * and said in a toast.
 */
export function ReactionsProvider({ sessionId, reactions = NO_MESSAGES, agentReactions = NO_MESSAGES, children }: {
  /** The thread; without one nothing is reactable. */
  sessionId?: string;
  reactions?: ReadonlyMap<string, readonly string[]>;
  agentReactions?: ReadonlyMap<string, readonly string[]>;
  children: React.ReactNode;
}): JSX.Element {
  const { showToast } = useToast();
  // A click waiting for its event: on (added) or off (removed).
  const [overlay, setOverlay] = useState<ReadonlyMap<string, { messageId: string; emoji: string; on: boolean }>>(new Map());

  // Drop each entry once the events agree with it.
  useEffect(() => {
    if (overlay.size === 0) return;
    const next = new Map(overlay);
    for (const [key, entry] of overlay) {
      if ((reactions.get(entry.messageId) ?? NO_REACTIONS).includes(entry.emoji) === entry.on) next.delete(key);
    }
    if (next.size !== overlay.size) setOverlay(next);
  }, [reactions, overlay]);

  const reactionsFor = useCallback((messageId: string): readonly string[] => {
    const base = reactions.get(messageId) ?? NO_REACTIONS;
    let result = base;
    for (const entry of overlay.values()) {
      if (entry.messageId !== messageId) continue;
      if (entry.on && !result.includes(entry.emoji)) result = [...result, entry.emoji];
      if (!entry.on && result.includes(entry.emoji)) result = result.filter((emoji) => emoji !== entry.emoji);
    }
    return result;
  }, [reactions, overlay]);

  const setReaction = useCallback((target: ReactionTarget, emoji: string, on: boolean) => {
    if (!sessionId) return;
    const key = overlayKey(target.messageId, emoji);
    setOverlay((previous) => new Map(previous).set(key, { messageId: target.messageId, emoji, on }));
    const forget = () => setOverlay((previous) => {
      const next = new Map(previous);
      next.delete(key);
      return next;
    });
    void fetch(`/api/harness/${encodeURIComponent(sessionId)}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId: target.messageId,
        emoji,
        action: on ? 'add' : 'remove',
        excerpt: target.excerpt,
        ...(target.worker ? { worker: target.worker } : {}),
        ...(target.sender ? { sender: target.sender } : {}),
      }),
    }).then(async (response) => {
      if (response.ok) return;
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }).catch((error: unknown) => {
      forget();
      showToast({
        type: 'error',
        title: on ? `Reaction ${emoji} not sent` : `Reaction ${emoji} not removed`,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [sessionId, showToast]);

  const actions = useRef(new Map<string, MessageActionsEntry>()).current;
  const [sheet, setSheet] = useState<ReactionTarget | null>(null);
  const openSheet = useCallback((target: ReactionTarget) => {
    // The selection it was opened from has done its job; leaving it up keeps
    // the iOS edit menu and the note bar over the sheet.
    window.getSelection()?.removeAllRanges();
    setSheet(target);
  }, []);

  const agentReactionsFor = useCallback(
    (messageId: string): readonly string[] => agentReactions.get(messageId) ?? NO_REACTIONS,
    [agentReactions],
  );

  const value = useMemo<ReactionsValue | null>(
    () => (sessionId ? { reactionsFor, agentReactionsFor, setReaction, actions, openSheet } : null),
    [sessionId, reactionsFor, agentReactionsFor, setReaction, actions, openSheet],
  );
  return (
    <ReactionsContext.Provider value={value}>
      {children}
      {value && sheet && <ReactionSheet target={sheet} onClose={() => setSheet(null)} />}
    </ReactionsContext.Provider>
  );
}

/** Offer a message's Copy (and React, with a target) to the touch selection bar while it is mounted. */
export function useRegisterMessageActions(messageId: string, text: string, reaction?: ReactionTarget): void {
  const actions = useContext(ReactionsContext)?.actions;
  // Keyed on the target's fields rather than the object, which callers rebuild every render.
  const targetId = reaction?.messageId;
  const excerpt = reaction?.excerpt;
  const worker = reaction?.worker;
  const sender = reaction?.sender;
  useEffect(() => {
    if (!actions || !messageId) return;
    const target: ReactionTarget | undefined = targetId === undefined || excerpt === undefined
      ? undefined
      : { messageId: targetId, excerpt, ...(worker ? { worker } : {}), ...(sender ? { sender } : {}) };
    const entry = { text, reaction: target };
    actions.set(messageId, entry);
    return () => {
      if (actions.get(messageId) === entry) actions.delete(messageId);
    };
  }, [actions, messageId, text, targetId, excerpt, worker, sender]);
}

/** Null outside a conversation thread (a subagent's nested messages, the labs), where nothing is reactable. */
export function useReactions(): ReactionsValue | null {
  return useContext(ReactionsContext);
}

/** The first non-empty line of a message, markdown markers and all. */
export function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/** Every reaction here is the user's own, and the thread's agent is the only other reactor. */
const YOU: readonly Reactor[] = [{ id: 'you', name: 'You' }];
const THE_AGENT: readonly Reactor[] = [{ id: 'agent', name: 'The agent' }];

function asGroups(emojis: readonly string[], reactors: readonly Reactor[], reactedByMe: boolean): ReactionGroup[] {
  return emojis.map((emoji) => ({ emoji, count: 1, reactedByMe, reactors }));
}

/** The toolkit's reaction props for one message: its reactions, and add/remove through the provider. */
function useMessageReactionProps(target: ReactionTarget) {
  const reactions = useReactions();
  if (!reactions) return null;
  return {
    reactions: asGroups(reactions.reactionsFor(target.messageId), YOU, true),
    onAdd: (emoji: string) => reactions.setReaction(target, emoji, true),
    onRemove: (emoji: string) => reactions.setReaction(target, emoji, false),
  };
}

/** The add-reaction control on desktop: a popover with the reaction menu. */
export function AddReactionButton({ target, className = '' }: { target: ReactionTarget; className?: string }): JSX.Element | null {
  const props = useMessageReactionProps(target);
  if (!props) return null;
  return <ToolkitAddReactionButton {...props} className={className} />;
}

/**
 * The reaction menu as a sheet over the composer, for touch: opened from the
 * bar a text selection brings up, which is gone by the time a pick is made.
 * Marked as annotation UI so the selection layer leaves taps on it alone.
 */
function ReactionSheet({ target, onClose }: { target: ReactionTarget; onClose: () => void }): JSX.Element | null {
  const props = useMessageReactionProps(target);
  if (!props) return null;
  return <ToolkitReactionSheet {...props} onClose={onClose} overlayAttributes={{ 'data-annotation-ui': 'true' }} />;
}

/**
 * React and Copy for the message a touch selection is in, shown beside
 * "Add note" in the bar the selection brings up. React is for the whole
 * message, like the desktop button; Copy copies the whole message (the iOS
 * menu already copies the selection). Acting on touchend, as the note pill
 * does: the tap would otherwise clear the selection and unmount the bar
 * before the click lands.
 */
export function SelectionMessageActions({ messageId }: { messageId: string }): JSX.Element | null {
  const reactions = useReactions();
  const [copied, setCopied] = useState(false);
  const touched = useRef(false);
  const entry = reactions?.actions.get(messageId);
  if (!reactions || !entry) return null;
  const onTap = (act: () => void) => ({
    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
    onTouchEnd: (event: React.TouchEvent) => {
      event.preventDefault();
      touched.current = true;
      act();
      window.setTimeout(() => { touched.current = false; }, 400);
    },
    onClick: () => {
      if (!touched.current) act();
    },
    style: { touchAction: 'manipulation' as const, WebkitTapHighlightColor: 'transparent' },
  });
  const copy = () => {
    if (!copyText(entry.text)) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <>
      {entry.reaction && (
        <button
          type="button"
          data-annotation-ui="true"
          data-testid="selection-react"
          aria-label="React to message"
          className={ANNOTATION_TOOLBAR_BUTTON}
          {...onTap(() => reactions.openSheet(entry.reaction as ReactionTarget))}
        >
          <SmilePlus size={20} className="flex-shrink-0" />
          React
        </button>
      )}
      <button
        type="button"
        data-annotation-ui="true"
        data-testid="selection-copy-message"
        aria-label={copied ? 'Copied' : 'Copy whole message'}
        className={ANNOTATION_TOOLBAR_BUTTON}
        {...onTap(copy)}
      >
        {copied ? <Check size={20} className="flex-shrink-0 text-emerald-400" /> : <Copy size={20} className="flex-shrink-0" />}
        {copied ? 'Copied' : 'Copy all'}
      </button>
    </>
  );
}

/**
 * The reactions on a message, under it. Every reaction is the user's, so there is
 * no count and no "yours" marker: just the emoji. Clicking one takes it off.
 */
export function ReactionChips({ target, className = '', ringed = false }: { target: ReactionTarget; className?: string; ringed?: boolean }): JSX.Element | null {
  const props = useMessageReactionProps(target);
  if (!props) return null;
  return <ToolkitReactionChips {...props} singleUser ringed={ringed} className={className} />;
}

/**
 * The agent's reactions on one of the user's messages. They are the agent's to
 * add and take back, so here they are only shown. They sit across the bottom
 * edge of the bubble, within its bottom padding, so they never cover its text;
 * a ring in the page colour separates each from the bubble.
 */
export function AgentReactionChips({ messageId, className = '' }: { messageId: string; className?: string }): JSX.Element | null {
  const reactions = useReactions();
  const current = reactions?.agentReactionsFor(messageId) ?? NO_REACTIONS;
  return (
    <ToolkitReactionChips
      reactions={asGroups(current, THE_AGENT, false)}
      singleUser
      ringed
      testId="agent-reactions"
      className={`relative justify-end ${className}`}
    />
  );
}
