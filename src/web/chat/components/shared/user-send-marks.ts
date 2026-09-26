import { useEffect, useState } from 'react';
import { parseJson } from '../../../../utils/json.js';

/**
 * "When did I last send something into this session?"
 *
 * Argus's arrow is a snapshot, not a live read: the scan computes it from
 * events up to `sourceBoundaryTs` and the sidebar polls the resulting file
 * every 30s. So a card keeps saying "Your move" for as long as the next scan
 * takes — while the user is looking at the reply they just sent. The arrow is the
 * one part of the card that asks something of the reader, so it is the one
 * part that must not lie.
 *
 * These marks are the client's own record of the acts the scan has not seen
 * yet. A mark newer than a read's boundary means the read predates the send,
 * and the arrow it carries is answering a question that has already been
 * answered.
 *
 * localStorage rather than context state: a mark that survives a reload or a
 * second tab is the difference between the arrow staying gone and coming back
 * the moment the page refreshes.
 */

export const USER_SEND_MARKS_KEY = 'lattice.session.lastUserSend';

/** Fired on `window` so cards in this tab update; `storage` covers the others. */
const USER_SEND_MARKS_EVENT = 'lattice:user-send-mark';

interface UserSendMarkDetail {
  conversationId: string;
  at: number;
}

/**
 * Marks older than this are dropped on write. Matches the ambient scan's own
 * dormancy window — a session it stopped reading has no arrow left to clear,
 * so its mark is dead weight in a key every card reads.
 */
const MARK_TTL_MS = 48 * 60 * 60 * 1000;

export type UserSendMarks = Record<string, number>;

export function readUserSendMarks(): UserSendMarks {
  try {
    const stored = window.localStorage.getItem(USER_SEND_MARKS_KEY);
    if (!stored) return {};
    const parsed: unknown = parseJson(stored);
    if (!parsed || typeof parsed !== 'object') return {};
    const marks: UserSendMarks = {};
    for (const [conversationId, at] of Object.entries(parsed)) {
      if (typeof at === 'number' && Number.isFinite(at)) marks[conversationId] = at;
    }
    return marks;
  } catch {
    // Storage disabled (private mode, blocked third-party context). No marks
    // means the arrows behave exactly as they did before this existed, which is
    // a far smaller failure than throwing during a sidebar render.
    return {};
  }
}

/** Record that the user just sent input into this session. */
export function markUserSend(conversationId: string, at: number = Date.now()): void {
  if (!conversationId) return;
  try {
    const marks = readUserSendMarks();
    const cutoff = at - MARK_TTL_MS;
    const next: UserSendMarks = { [conversationId]: at };
    for (const [id, markedAt] of Object.entries(marks)) {
      if (id !== conversationId && markedAt >= cutoff) next[id] = markedAt;
    }
    window.localStorage.setItem(USER_SEND_MARKS_KEY, JSON.stringify(next));
  } catch {
    // Ignore — the event below still clears the arrow for the rest of this session.
  }
  window.dispatchEvent(new CustomEvent<UserSendMarkDetail>(USER_SEND_MARKS_EVENT, {
    detail: { conversationId, at },
  }));
}

/**
 * The marks, kept live. Local sends arrive via the custom event above; sends
 * from another tab arrive via `storage`, which fires only across tabs.
 */
export function useUserSendMarks(): UserSendMarks {
  const [marks, setMarks] = useState<UserSendMarks>(() => readUserSendMarks());

  useEffect(() => {
    const syncStorage = (): void => setMarks(readUserSendMarks());
    const syncLocal = (event: Event): void => {
      const detail = (event as CustomEvent<UserSendMarkDetail>).detail;
      if (!detail?.conversationId || !Number.isFinite(detail.at)) {
        syncStorage();
        return;
      }
      // Use the event itself as the same-tab source of truth. This still works
      // when localStorage is unavailable, while a later successful read can
      // replace it with the persisted cross-tab view.
      setMarks((current) => ({ ...current, [detail.conversationId]: detail.at }));
    };
    window.addEventListener(USER_SEND_MARKS_EVENT, syncLocal);
    window.addEventListener('storage', syncStorage);
    return () => {
      window.removeEventListener(USER_SEND_MARKS_EVENT, syncLocal);
      window.removeEventListener('storage', syncStorage);
    };
  }, []);

  return marks;
}
