import { useEffect, useRef, useState } from 'react';
import type { HydrationPhase } from '@liggi/agent-ui-harness/client';

interface MessageLike {
  id?: string;
  messageId?: string;
}

/**
 * Drives the entry animation for messages arriving in the list.
 *
 * The key concept is **hydration phase**. A message arrival means one of two
 * very different things:
 *
 * - **Hydration arrival**: the session is still catching up — initial SSE
 *   replay, automatic history backfill after scoped replay, or a scroll-up
 *   page load. These messages are not "new" to the user; they're being
 *   rendered because the client is hydrating state. They must never animate.
 * - **Live arrival**: the session is caught up (`hydrationPhase === 'ready'`)
 *   and a genuinely new message has landed — a live assistant turn, an
 *   optimistic user send, a tool result. These should animate.
 *
 * The previous design gated animation on "is this message ID in the
 * already-seen set?" which mis-classified every backfilled historical
 * message as "new," producing a visible pop-in on cold load. Keying on
 * hydration phase instead eliminates that class of bug.
 */
export function useMessageAnimation(params: {
  sessionId?: string;
  messages: MessageLike[];
  hydrationPhase: HydrationPhase;
}): {
  hasShownContent: boolean;
  newMessageIds: Map<string, number>;
} {
  const { sessionId, messages, hydrationPhase } = params;
  const prevSessionIdRef = useRef(sessionId);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const prevMessageCountRef = useRef(0);
  const prevHydrationPhaseRef = useRef<HydrationPhase>('hydrating');
  const [hasShownContent, setHasShownContent] = useState(false);
  const [newMessageIds, setNewMessageIds] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    if (sessionId === prevSessionIdRef.current) {
      return;
    }

    prevSessionIdRef.current = sessionId;
    setHasShownContent(false);
    seenMessageIdsRef.current = new Set();
    prevMessageCountRef.current = 0;
    prevHydrationPhaseRef.current = 'hydrating';
    setNewMessageIds(new Map());
  }, [sessionId]);

  useEffect(() => {
    if (messages.length > 0 && !hasShownContent) {
      requestAnimationFrame(() => {
        setHasShownContent(true);
      });
    }
  }, [messages.length, hasShownContent]);

  useEffect(() => {
    const currentIds = new Set(
      messages.map((message) => message.messageId || message.id).filter(Boolean) as string[]
    );

    // Hydrating → ready transition: React 18 batches state updates from async
    // callbacks, so the harness's PREPEND_HISTORY dispatch and setHydrationPhase
    // ('ready') fire in the same render. That means the first render we observe
    // in 'ready' can carry a full backfilled message list we never saw in
    // 'hydrating'. Absorb everything as baseline before running live-arrival
    // logic — these messages are catch-up, not live.
    const prevPhase = prevHydrationPhaseRef.current;
    prevHydrationPhaseRef.current = hydrationPhase;
    if (prevPhase === 'hydrating' && hydrationPhase === 'ready') {
      currentIds.forEach((id) => seenMessageIdsRef.current.add(id));
      prevMessageCountRef.current = currentIds.size;
      if (newMessageIds.size > 0) setNewMessageIds(new Map());
      return;
    }

    // Identify IDs that are new vs the pre-existing seen set, preserving
    // message order for stagger sequencing.
    const nextNewIds = new Map<string, number>();
    let staggerIndex = 0;
    messages.forEach((message) => {
      const id = message.messageId || message.id;
      if (id && !seenMessageIdsRef.current.has(id)) {
        nextNewIds.set(id, staggerIndex++);
      }
    });

    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = currentIds.size;

    // Always absorb current IDs into the "seen" set. We do this regardless
    // of hydration phase so that once we transition to 'ready', historical
    // content already on screen isn't retroactively flagged as new.
    currentIds.forEach((id) => seenMessageIdsRef.current.add(id));

    // During hydration, never animate. Arrivals are catch-up, not live.
    // The seenMessageIdsRef update above ensures these IDs won't animate
    // later either — they've been observed.
    if (hydrationPhase === 'hydrating') {
      if (newMessageIds.size > 0) setNewMessageIds(new Map());
      return;
    }

    // Only animate when the total message count actually increased.
    // "New" IDs without a count increase are replacements (e.g., optimistic
    // user message replaced by server-confirmed version on completion refetch),
    // not genuinely new messages the user hasn't seen.
    if (nextNewIds.size === 0 || currentIds.size <= prevCount) {
      return;
    }

    setNewMessageIds(nextNewIds);
    const timer = setTimeout(() => {
      setNewMessageIds(new Map());
    }, 300);
    return () => clearTimeout(timer);
    // newMessageIds is only read for the empty-check — don't re-run when we set it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, hydrationPhase]);

  return {
    hasShownContent,
    newMessageIds,
  };
}
