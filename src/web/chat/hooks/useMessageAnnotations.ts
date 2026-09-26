import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { storage } from '../utils/storage';
import {
  annotationsStorageKey,
  sanitizeStoredAnnotations,
  type PendingAnnotation,
} from '../utils/annotations-format';

export interface AddAnnotationInput {
  messageId: string;
  quote: string;
  note: string;
  /** Where the quote started in the message; see PendingAnnotation.quoteStart. */
  quoteStart?: number | null;
}

export interface MessageAnnotationsApi {
  /** Pending annotations for the current conversation, oldest first. */
  annotations: PendingAnnotation[];
  addAnnotation: (input: AddAnnotationInput) => void;
  /** Replaces a pending note's text; an empty note is ignored. */
  updateAnnotation: (id: string, note: string) => void;
  removeAnnotation: (id: string) => void;
  clearAnnotations: () => void;
  /**
   * Stable reader for the send path — avoids re-creating the send callback.
   * Leaves out notes already riding on a send that has not resolved, so a
   * repeat click cannot put the same notes in a second message.
   */
  getPendingAnnotations: () => PendingAnnotation[];
  /** How many of `annotations` are on a send that has not resolved yet. */
  sendingCount: number;
  /** Marks notes as riding on a send, synchronously, before the request goes. */
  beginSendingAnnotations: (ids: string[]) => void;
  /** Hands notes back as pending after their send was refused or failed. */
  releaseAnnotations: (ids: string[]) => void;
  /**
   * Clears the given annotations from state + storage. Called only after a send
   * resolves, and only for the ids that actually went out, so a note added
   * while the request was in flight survives.
   */
  consumeAnnotations: (sentIds: string[]) => void;
}

function newAnnotationId(): string {
  const cryptoRef = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  return `ann-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Owns the pending note-annotations for one conversation.
 *
 * Persisted to localStorage per conversation so a refresh mid-composition does
 * not lose the notes, and cleared only once the message they ride on has been
 * handed to the session.
 */
export function useMessageAnnotations(conversationId: string | undefined): MessageAnnotationsApi {
  const storageKey = annotationsStorageKey(conversationId);
  const [annotations, setAnnotations] = useState<PendingAnnotation[]>(
    () => sanitizeStoredAnnotations(storage.get<unknown>(storageKey, [])),
  );

  // Mirror into a ref so the send path can read the latest value without the
  // send callback depending on (and churning with) the annotations array.
  const annotationsRef = useRef<PendingAnnotation[]>(annotations);
  annotationsRef.current = annotations;

  // Ids on a send that has not resolved. Not persisted: after a reload the
  // request is gone from this page, and the notes are pending again.
  const sendingRef = useRef<ReadonlySet<string>>(new Set());
  const [sendingIds, setSendingIds] = useState<ReadonlySet<string>>(sendingRef.current);
  const commitSending = useCallback((next: ReadonlySet<string>) => {
    sendingRef.current = next;
    setSendingIds(next);
  }, []);

  // Reload when the conversation changes — each conversation has its own notes.
  const loadedKeyRef = useRef(storageKey);
  useEffect(() => {
    if (loadedKeyRef.current === storageKey) return;
    loadedKeyRef.current = storageKey;
    const next = sanitizeStoredAnnotations(storage.get<unknown>(storageKey, []));
    annotationsRef.current = next;
    setAnnotations(next);
    commitSending(new Set());
  }, [storageKey, commitSending]);

  /**
   * Single write path: ref first (so back-to-back calls in one tick compose),
   * then storage, then state. Deliberately not done inside a setState updater —
   * updaters must stay pure, and StrictMode invokes them twice in development.
   */
  const commit = useCallback((next: PendingAnnotation[]) => {
    annotationsRef.current = next;
    if (next.length === 0) {
      storage.remove(storageKey);
    } else {
      storage.set(storageKey, next);
    }
    setAnnotations(next);
  }, [storageKey]);

  const addAnnotation = useCallback((input: AddAnnotationInput) => {
    const quote = input.quote;
    const note = input.note.trim();
    if (quote.trim() === '' || note === '') return;
    const { quoteStart } = input;
    commit([
      ...annotationsRef.current,
      {
        id: newAnnotationId(),
        messageId: input.messageId,
        quote,
        note,
        ...(typeof quoteStart === 'number' && quoteStart >= 0 ? { quoteStart } : {}),
        createdAt: Date.now(),
      },
    ]);
  }, [commit]);

  const updateAnnotation = useCallback((id: string, note: string) => {
    const trimmed = note.trim();
    if (trimmed === '') return;
    const current = annotationsRef.current;
    if (!current.some((annotation) => annotation.id === id && annotation.note !== trimmed)) return;
    commit(current.map((annotation) => (annotation.id === id ? { ...annotation, note: trimmed } : annotation)));
  }, [commit]);

  const removeAnnotation = useCallback((id: string) => {
    const next = annotationsRef.current.filter((annotation) => annotation.id !== id);
    if (next.length === annotationsRef.current.length) return;
    commit(next);
  }, [commit]);

  const clearAnnotations = useCallback(() => {
    if (annotationsRef.current.length === 0) return;
    commit([]);
  }, [commit]);

  const getPendingAnnotations = useCallback(
    () => annotationsRef.current.filter((annotation) => !sendingRef.current.has(annotation.id)),
    [],
  );

  const beginSendingAnnotations = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    commitSending(new Set([...sendingRef.current, ...ids]));
  }, [commitSending]);

  const releaseAnnotations = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const released = new Set(ids);
    commitSending(new Set([...sendingRef.current].filter((id) => !released.has(id))));
  }, [commitSending]);

  const consumeAnnotations = useCallback((sentIds: string[]) => {
    if (sentIds.length === 0) return;
    const sent = new Set(sentIds);
    releaseAnnotations(sentIds);
    const next = annotationsRef.current.filter((annotation) => !sent.has(annotation.id));
    if (next.length === annotationsRef.current.length) return;
    commit(next);
  }, [commit, releaseAnnotations]);

  const sendingCount = annotations.filter((annotation) => sendingIds.has(annotation.id)).length;

  return useMemo(() => ({
    annotations,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    clearAnnotations,
    getPendingAnnotations,
    sendingCount,
    beginSendingAnnotations,
    releaseAnnotations,
    consumeAnnotations,
  }), [
    annotations,
    sendingCount,
    beginSendingAnnotations,
    releaseAnnotations,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    clearAnnotations,
    getPendingAnnotations,
    consumeAnnotations,
  ]);
}
