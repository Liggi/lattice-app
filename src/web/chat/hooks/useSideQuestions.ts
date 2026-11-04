import { useCallback, useEffect, useRef, useState } from 'react';
import type { SideChatStart, SideQuestion } from '@/services/side-questions/side-questions';

export type { SideQuestion };

export interface SideQuestionsApi {
  sideQuestions: SideQuestion[];
  /** Open a side chat about a passage and start its first turn; resolves with the side chat once it is running. */
  ask: (input: { messageId: string; quote: string; quoteStart: number | null; question: string }) => Promise<SideQuestion>;
  addToThread: (id: string) => Promise<void>;
  /** Load the side chats again (their question counts move as the user asks in them). */
  refresh: () => Promise<void>;
}

async function errorOf(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return new Error(body?.error ?? `HTTP ${response.status}`);
}

/**
 * The side chats of one conversation (services/side-questions/side-questions.ts),
 * loaded from the server so they survive a reload. Each one is a hidden
 * session; once it exists, the page talks to it like any other session.
 */
export function useSideQuestions(conversationId: string | undefined): SideQuestionsApi {
  const [sideQuestions, setSideQuestions] = useState<SideQuestion[]>([]);
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;

  const upsert = useCallback((sideQuestion: SideQuestion) => {
    if (sideQuestion.conversationId !== conversationRef.current) return;
    setSideQuestions((current) => {
      const index = current.findIndex((candidate) => candidate.id === sideQuestion.id);
      if (index < 0) return [...current, sideQuestion];
      const next = current.slice();
      next[index] = sideQuestion;
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const id = conversationRef.current;
    if (!id) return;
    const response = await fetch(`/api/side-questions?conversationId=${encodeURIComponent(id)}`);
    if (!response.ok) return;
    const body = await response.json() as { sideQuestions: SideQuestion[] };
    if (conversationRef.current === id) setSideQuestions(body.sideQuestions);
  }, []);

  useEffect(() => {
    setSideQuestions([]);
    void refresh();
  }, [conversationId, refresh]);

  const ask = useCallback<SideQuestionsApi['ask']>(async (input) => {
    const response = await fetch('/api/side-questions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: conversationRef.current, ...input }),
    });
    if (!response.ok) throw await errorOf(response);
    const { sideQuestion, start } = await response.json() as { sideQuestion: SideQuestion; start: SideChatStart };
    upsert(sideQuestion);
    // The same start the composer makes for a session with no process yet.
    const started = await fetch(`/api/harness/${encodeURIComponent(sideQuestion.sideConversationId!)}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: start.prompt, ...(start.permissionMode ? { permissionMode: start.permissionMode } : {}) }),
    });
    if (!started.ok) throw await errorOf(started);
    return sideQuestion;
  }, [upsert]);

  const addToThread = useCallback<SideQuestionsApi['addToThread']>(async (id) => {
    const response = await fetch(`/api/side-questions/${encodeURIComponent(id)}/add-to-thread`, { method: 'POST' });
    if (!response.ok) throw await errorOf(response);
    const body = await response.json() as { sideQuestion: SideQuestion };
    upsert(body.sideQuestion);
  }, [upsert]);

  return { sideQuestions, ask, addToThread, refresh };
}
