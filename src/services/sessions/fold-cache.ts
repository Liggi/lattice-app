/**
 * Folds over a conversation's full event log, kept until the log changes.
 *
 * The workers panel refetches on every worker event, status change and
 * session switch, and each request folded the coordinator's whole log again:
 * three folds over 1-3MB of events, run synchronously on the server's only
 * thread. A fold is a pure function of the events of its types, so the newest
 * seq and the count of those events say whether the answer can have changed.
 */

import { getEvents, getEventsVersion } from '../../session-history/repository.js';
import type { RawEvent } from '../../session-history/types.js';

const MAX_ENTRIES = 64;

interface Entry {
  maxSeq: number;
  count: number;
  value: unknown;
}

const entries = new Map<string, Entry>();

/**
 * `fold` over the conversation's events of `types`, recomputed only when an
 * event of those types has been added or removed. Returns a copy, so a caller
 * that mutates the result cannot change what the next caller gets.
 */
export function cachedFold<T>(
  name: string,
  conversationId: string,
  types: readonly string[],
  fold: (events: RawEvent[]) => T,
): T {
  const key = `${name}\u0000${conversationId}`;
  const version = getEventsVersion(conversationId, types);
  const hit = entries.get(key);
  if (hit && hit.maxSeq === version.maxSeq && hit.count === version.count) {
    entries.delete(key);
    entries.set(key, hit);
    return globalThis.structuredClone(hit.value) as T;
  }
  const value = fold(getEvents(conversationId, { types }));
  entries.delete(key);
  entries.set(key, { ...version, value });
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  return globalThis.structuredClone(value);
}

/** For tests. */
export function clearFoldCache(): void {
  entries.clear();
}
