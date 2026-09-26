/**
 * Drives one inline highlight→ask: record it, route it to a session, stream the
 * reply back into the card, and write the finished answer to the exchange.
 *
 * Streaming reuses the chat view's own machinery — `useHarnessSession` for the
 * event stream, and the same send/start branch ConversationView uses (`/send`
 * when the SSE transport is attached, `POST /api/harness/:id/start` when there
 * is no live session yet). The hook is mounted for the resolved conversation
 * from page load rather than at ask time, so `connected` has settled long
 * before the branch is taken; deciding it milliseconds after wiring up the
 * stream would read false for a perfectly healthy session.
 *
 * One ask at a time. Two concurrent asks would both be reading the same
 * transcript for "the answer after my question", and the second would have to
 * guess which stream was whose. The affordance says so instead of guessing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../services/api';
import { answerExchange, createExchange, updateMap, type KmExchange } from '../../../services/api/km-api';
import { usePreferencesContext } from '../../../contexts/PreferencesContext';
import { useHarnessSession } from '../../../hooks/useHarnessSession';
import { buildAskMessage } from './ask-message';
import { extractAnswerAfter } from './answer-text';
import { resolveResponder } from './responder';
import type { LiveAsk } from './ask-state';

/**
 * How long the responder may sit idle, with our question in its transcript and
 * no text after it, before the ask is called failed. Generous: a session can
 * legitimately spend minutes on tools before it writes a word, and this only
 * counts *idle* time, not working time.
 */
const SILENT_IDLE_TIMEOUT_MS = 60_000;
const WATCHDOG_TICK_MS = 15_000;

export interface AskInput {
  quote: string;
  quoteStart: number | null;
  question: string;
}

export interface UseArticleResponderInput {
  mapId: string;
  mapName: string;
  articleId: string;
  articleTitle: string;
  /** The article's own provenance session, if it has one. */
  articleConv: string | null;
  /** The map's fallback responder, if it has one. */
  mapDefaultConv: string | null;
  /** A new exchange row was written; render it immediately. */
  onCreated: (exchange: KmExchange) => void;
  /** An exchange was answered and persisted. */
  onAnswered: (exchange: KmExchange) => void;
  /** A conversation was created and saved as the map's default. */
  onDefaultConv: (conversationId: string) => void;
}

export interface ArticleResponder {
  live: LiveAsk | null;
  ask: (input: AskInput) => void;
  /** Non-fatal thing the reader should know about. Dismissable. */
  notice: string | null;
  dismissNotice: () => void;
  /** Conversation currently wired for streaming, for the provenance line. */
  conversationId: string | null;
  /** True while an ask is in flight, so the affordance can say why it is busy. */
  busy: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useArticleResponder(input: UseArticleResponderInput): ArticleResponder {
  const {
    mapId, mapName, articleId, articleTitle,
    articleConv, mapDefaultConv,
    onCreated, onAnswered, onDefaultConv,
  } = input;

  const { serverConfig } = usePreferencesContext();
  const [createdConv, setCreatedConv] = useState<string | null>(null);
  const [live, setLive] = useState<LiveAsk | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Derived rather than synced: the detail fetch fills these in after mount,
  // and a state mirror would need an effect to chase them.
  const conversationId = createdConv ?? articleConv ?? mapDefaultConv;
  const session = useHarnessSession(conversationId);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const liveRef = useRef<LiveAsk | null>(live);
  liveRef.current = live;
  const askMessageRef = useRef('');
  /** True once the responder was observed working on our question. */
  const sawStreamingRef = useRef(false);
  /** When the session last went idle with our question unanswered. */
  const silentSinceRef = useRef<number | null>(null);
  /** Guards against a second persist if the effect re-runs mid-write. */
  const persistingRef = useRef(false);

  const callbacksRef = useRef({ onCreated, onAnswered, onDefaultConv });
  callbacksRef.current = { onCreated, onAnswered, onDefaultConv };

  const fail = useCallback((message: string) => {
    setLive((current) => (current ? { ...current, status: 'error', error: message } : current));
  }, []);

  /**
   * Hands the message to an existing conversation. Mirrors ConversationView:
   * `/send` injects into a live session (queued by the CLI if it is mid-turn),
   * and `/start` spawns one when the process has gone away.
   */
  const deliverToExisting = useCallback(async (convId: string, message: string) => {
    const current = sessionRef.current;
    if (current.connected) {
      await current.send(message);
      return;
    }
    const response = await fetch(`/api/harness/${encodeURIComponent(convId)}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: message }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `The responder session could not be started (${response.status})`);
    }
    current.reconnect();
  }, []);

  const runAsk = useCallback(async ({ quote, quoteStart, question }: AskInput) => {
    const askMessage = buildAskMessage({ articleTitle, mapName, quote, question });
    askMessageRef.current = askMessage;
    sawStreamingRef.current = false;
    silentSinceRef.current = null;
    persistingRef.current = false;

    setLive({
      exchangeId: null, question, quote, quoteStart,
      status: 'creating', answer: '', error: null,
    });

    let exchange: KmExchange;
    try {
      ({ exchange } = await createExchange(articleId, {
        quote,
        quote_start: quoteStart,
        question,
      }));
    } catch (error) {
      fail(`The question could not be recorded: ${errorText(error)}`);
      return;
    }

    callbacksRef.current.onCreated(exchange);
    setLive((current) => (current
      ? { ...current, exchangeId: exchange.id, status: 'connecting' }
      : current));

    try {
      const resolution = await resolveResponder({
        articleConv,
        mapDefaultConv,
        createConversation: async (firstMessage) => {
          const created = await api.createConversation({
            provider: 'claude',
            message: firstMessage,
            workingDirectory: serverConfig?.defaultWorkingDirectory || serverConfig?.cwd || '~',
            ...(serverConfig?.defaultModel ? { model: serverConfig.defaultModel } : {}),
            ...(serverConfig?.defaultPermissionMode
              ? { permissionMode: serverConfig.defaultPermissionMode }
              : {}),
          });
          return created.conversationId;
        },
        saveMapDefault: async (id) => {
          await updateMap(mapId, { default_conv: id });
          callbacksRef.current.onDefaultConv(id);
        },
      }, askMessage);

      if (resolution.defaultSaveError) {
        setNotice(
          'This map could not be given a default session '
          + `(${resolution.defaultSaveError}) — the next question here will start another one.`,
        );
      }

      if (resolution.deliveredWithCreate) {
        // Creation carried the prompt; wiring the stream is all that is left.
        setCreatedConv(resolution.conversationId);
      } else {
        await deliverToExisting(resolution.conversationId, askMessage);
      }

      setLive((current) => (current ? { ...current, status: 'streaming' } : current));
    } catch (error) {
      fail(`The responder session did not accept the question: ${errorText(error)}`);
    }
  }, [
    articleId, articleTitle, articleConv, mapId, mapName, mapDefaultConv,
    serverConfig, deliverToExisting, fail,
  ]);

  const ask = useCallback((askInput: AskInput) => {
    const current = liveRef.current;
    if (current && current.status !== 'error') {
      setNotice('One question at a time — the previous answer is still coming back.');
      return;
    }
    setNotice(null);
    void runAsk(askInput);
  }, [runAsk]);

  // --- Reading the answer out of the responder's transcript ---------------
  useEffect(() => {
    const current = liveRef.current;
    if (!current || current.status !== 'streaming' || !current.exchangeId) return;
    if (persistingRef.current) return;

    if (session.error) {
      fail(`The responder session reported an error: ${session.error}`);
      return;
    }

    const { found, text } = extractAnswerAfter(session.messages, askMessageRef.current);
    if (!found) return;

    if (text !== current.answer) {
      setLive((value) => (value ? { ...value, answer: text } : value));
    }

    if (session.status !== 'idle') {
      sawStreamingRef.current = true;
      silentSinceRef.current = null;
      return;
    }

    // Idle with nothing written yet means the turn carrying our question has
    // not run: it is queued behind whatever the session was already doing.
    // Keep waiting — the watchdog handles a session that never speaks.
    if (text === '') {
      if (silentSinceRef.current === null) silentSinceRef.current = Date.now();
      return;
    }
    if (!sawStreamingRef.current) return;

    persistingRef.current = true;
    const exchangeId = current.exchangeId;
    setLive((value) => (value ? { ...value, status: 'saving' } : value));
    void (async () => {
      try {
        const { exchange } = await answerExchange(exchangeId, text);
        callbacksRef.current.onAnswered(exchange);
        setLive(null);
      } catch (error) {
        fail(`The answer arrived but could not be saved: ${errorText(error)}`);
      } finally {
        persistingRef.current = false;
      }
    })();
    // `live.status` is a dependency, not just a ref read: the transition into
    // 'streaming' can land after the last message arrived (a turn that finishes
    // before the send call resolves), and without it that answer would sit in
    // the transcript with nothing left to trigger a read of it. Answer-text
    // updates keep the same status, so this does not spin.
  }, [session.messages, session.status, session.error, live?.status, fail]);

  // --- Watchdog: a responder that goes quiet without answering -------------
  useEffect(() => {
    if (!live || live.status !== 'streaming') return;
    const timer = window.setInterval(() => {
      const since = silentSinceRef.current;
      if (since === null) return;
      if (Date.now() - since < SILENT_IDLE_TIMEOUT_MS) return;
      fail('The responder session went idle without answering. The question is '
        + 'saved unanswered — open the session to see what it did instead.');
    }, WATCHDOG_TICK_MS);
    return () => window.clearInterval(timer);
  }, [live, fail]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    live,
    ask,
    notice,
    dismissNotice,
    conversationId,
    busy: live !== null && live.status !== 'error',
  };
}
