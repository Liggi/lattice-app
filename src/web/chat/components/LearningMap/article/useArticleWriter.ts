/**
 * Writes the article at the end of a follow: brief a session on where the
 * reader came from and what they asked, stream the reply into the empty page,
 * and save it as the article's body.
 *
 * This is the sibling of `useArticleResponder`. The two flows are genuinely
 * different — one appends a margin note to an article that already exists, the
 * other *is* the article — but they reach a session the same way, so the same
 * proven pieces do the work here: `resolveResponder` for which session answers,
 * `useHarnessSession` for the event stream, the `/send`-vs-`/start` branch
 * ConversationView uses, `extractAnswerAfter` for reading one answer out of a
 * transcript that may have other turns in it, and the silent-idle watchdog.
 *
 * They are deliberately not folded together. The ask flow works, and the shared
 * part is a hundred lines of session plumbing whose branches are the same but
 * whose lifecycle is not: this one has no exchange row, persists to a different
 * column, and records the writing session on the article afterwards.
 *
 * One write at a time, for the same reason one ask at a time: two writes would
 * both be reading the same transcript for "the text after my brief".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../services/api';
import { updateArticle, updateMap, type KmArticle } from '../../../services/api/km-api';
import { usePreferencesContext } from '../../../contexts/PreferencesContext';
import { useHarnessSession } from '../../../hooks/useHarnessSession';
import { extractAnswerAfter } from './answer-text';
import { resolveResponder } from './responder';
import { buildWriteMessage } from './write-message';

/**
 * How long the session may sit idle with the brief in its transcript and
 * nothing written after it before the write is called failed. Same budget as an
 * ask: it counts idle time only, so a session that spends minutes on tools
 * before writing a word is not penalised for it.
 */
const SILENT_IDLE_TIMEOUT_MS = 60_000;
const WATCHDOG_TICK_MS = 15_000;

export type WriteStatus =
  /** Reaching the session that will write it. */
  | 'connecting'
  /** The brief is with the session; the article is arriving. */
  | 'streaming'
  /** Turn finished; saving the body to the article. */
  | 'saving'
  /** Nothing further will arrive. The article stays empty. */
  | 'error';

/** Chrome label per state, matching the ask flow's vocabulary. */
export const WRITE_STATUS_LABEL: Record<WriteStatus, string> = {
  connecting: 'Reaching session',
  streaming: 'Writing',
  saving: 'Saving',
  error: 'Failed',
};

export interface LiveWrite {
  /** The question that led here, shown while there is no article to show. */
  question: string;
  concept: string;
  status: WriteStatus;
  /** The article as it streams. Empty until the session starts writing. */
  text: string;
  error: string | null;
}

export interface WriteInput {
  question: string;
  /** The bold term followed — the new article's subject. */
  concept: string;
  parentTitle: string;
  /** The parent's whole body, as context. Never truncated. */
  parentContent: string;
}

export interface UseArticleWriterInput {
  mapId: string;
  mapName: string;
  /** The empty article being written. */
  articleId: string;
  /** Its own provenance session, if it has one. */
  articleConv: string | null;
  /** The map's fallback responder, if it has one. */
  mapDefaultConv: string | null;
  /** The body was written and persisted. */
  onWritten: (article: KmArticle) => void;
  /** A conversation was created and saved as the map's default. */
  onDefaultConv: (conversationId: string) => void;
}

export interface ArticleWriter {
  live: LiveWrite | null;
  write: (input: WriteInput) => void;
  /** Non-fatal thing the reader should know about. Dismissable. */
  notice: string | null;
  dismissNotice: () => void;
  /** Conversation currently wired for streaming. */
  conversationId: string | null;
  busy: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useArticleWriter(input: UseArticleWriterInput): ArticleWriter {
  const {
    mapId, mapName, articleId,
    articleConv, mapDefaultConv,
    onWritten, onDefaultConv,
  } = input;

  const { serverConfig } = usePreferencesContext();
  const [createdConv, setCreatedConv] = useState<string | null>(null);
  const [live, setLive] = useState<LiveWrite | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const conversationId = createdConv ?? articleConv ?? mapDefaultConv;
  const session = useHarnessSession(conversationId);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const liveRef = useRef<LiveWrite | null>(live);
  liveRef.current = live;
  /** The line the written article is located after in the transcript. */
  const markerRef = useRef('');
  /** The session that took the brief, recorded on the article once it lands. */
  const writingConvRef = useRef<string | null>(null);
  /** True once the session was observed working on our brief. */
  const sawStreamingRef = useRef(false);
  /** When the session last went idle with the article unwritten. */
  const silentSinceRef = useRef<number | null>(null);
  /** Guards against a second save if the effect re-runs mid-write. */
  const persistingRef = useRef(false);

  const callbacksRef = useRef({ onWritten, onDefaultConv });
  callbacksRef.current = { onWritten, onDefaultConv };

  const fail = useCallback((message: string) => {
    setLive((current) => (current ? { ...current, status: 'error', error: message } : current));
  }, []);

  /**
   * Hands the brief to an existing conversation. Mirrors ConversationView:
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
      throw new Error(body.error ?? `The writing session could not be started (${response.status})`);
    }
    current.reconnect();
  }, []);

  const runWrite = useCallback(async (writeInput: WriteInput) => {
    const { question, concept, parentTitle, parentContent } = writeInput;
    const { marker, message } = buildWriteMessage({
      mapName, parentTitle, parentContent, concept, question,
    });
    markerRef.current = marker;
    writingConvRef.current = null;
    sawStreamingRef.current = false;
    silentSinceRef.current = null;
    persistingRef.current = false;

    setLive({ question, concept, status: 'connecting', text: '', error: null });

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
      }, message);

      if (resolution.defaultSaveError) {
        setNotice(
          'This map could not be given a default session '
          + `(${resolution.defaultSaveError}) — the next article written here will start another one.`,
        );
      }

      writingConvRef.current = resolution.conversationId;

      if (resolution.deliveredWithCreate) {
        // Creation carried the brief; wiring the stream is all that is left.
        setCreatedConv(resolution.conversationId);
      } else {
        await deliverToExisting(resolution.conversationId, message);
      }

      setLive((current) => (current ? { ...current, status: 'streaming' } : current));
    } catch (error) {
      fail(`The writing session did not accept the question: ${errorText(error)}`);
    }
  }, [
    mapId, mapName, articleConv, mapDefaultConv,
    serverConfig, deliverToExisting, fail,
  ]);

  const write = useCallback((writeInput: WriteInput) => {
    const current = liveRef.current;
    if (current && current.status !== 'error') return;
    setNotice(null);
    void runWrite(writeInput);
  }, [runWrite]);

  // --- Reading the article out of the session's transcript ----------------
  useEffect(() => {
    const current = liveRef.current;
    if (!current || current.status !== 'streaming') return;
    if (persistingRef.current) return;

    if (session.error) {
      fail(`The writing session reported an error: ${session.error}`);
      return;
    }

    const { found, text } = extractAnswerAfter(session.messages, markerRef.current);
    if (!found) return;

    if (text !== current.text) {
      setLive((value) => (value ? { ...value, text } : value));
    }

    if (session.status !== 'idle') {
      sawStreamingRef.current = true;
      silentSinceRef.current = null;
      return;
    }

    // Idle with nothing written yet means the turn carrying our brief has not
    // run: it is queued behind whatever the session was already doing. Keep
    // waiting — the watchdog handles a session that never speaks.
    if (text === '') {
      if (silentSinceRef.current === null) silentSinceRef.current = Date.now();
      return;
    }
    if (!sawStreamingRef.current) return;

    persistingRef.current = true;
    const writingConv = writingConvRef.current;
    setLive((value) => (value ? { ...value, status: 'saving' } : value));
    void (async () => {
      try {
        const { article } = await updateArticle(articleId, {
          content_md: text,
          // The article records the session that actually wrote it, which is
          // not always the one it was created with — a map with no responder
          // yet gets one made here.
          ...(writingConv ? { created_by_conv: writingConv } : {}),
        });
        callbacksRef.current.onWritten(article);
        setLive(null);
      } catch (error) {
        fail(`The article was written but could not be saved: ${errorText(error)}`);
      } finally {
        persistingRef.current = false;
      }
    })();
    // `live.status` is a dependency, not just a ref read: the transition into
    // 'streaming' can land after the last message arrived, and without it that
    // text would sit in the transcript with nothing left to trigger a read of
    // it. Article-text updates keep the same status, so this does not spin.
  }, [session.messages, session.status, session.error, live?.status, articleId, fail]);

  // --- Watchdog: a session that goes quiet without writing -----------------
  useEffect(() => {
    if (!live || live.status !== 'streaming') return;
    const timer = window.setInterval(() => {
      const since = silentSinceRef.current;
      if (since === null) return;
      if (Date.now() - since < SILENT_IDLE_TIMEOUT_MS) return;
      fail('The writing session went idle without writing anything. The node is '
        + 'on the map with the question that made it — open the session to see '
        + 'what it did instead.');
    }, WATCHDOG_TICK_MS);
    return () => window.clearInterval(timer);
  }, [live, fail]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    live,
    write,
    notice,
    dismissNotice,
    conversationId,
    busy: live !== null && live.status !== 'error',
  };
}
