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
/** Parsed logs held for re-folding; a coordinator's can be a few MB, so fewer than the folds. */
const MAX_LOGS = 16;

interface Entry {
  maxSeq: number;
  count: number;
  value: unknown;
}

interface Log {
  maxSeq: number;
  events: RawEvent[];
}

const entries = new Map<string, Entry>();
const logs = new Map<string, Log>();

function touch<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value!);
}

/**
 * The conversation's events of `types`, reading only what was added since the
 * last read. Every coordinator turn end changes the project fold's version, and
 * re-reading and parsing its ~3,000 events each time was 1.6s of a 9.4s
 * event-loop block on 3045 (2026-09-30). A count that does not add up (an
 * event removed or copied in below the newest seq) reads the whole set again.
 */
function eventsOf(conversationId: string, types: readonly string[], version: { maxSeq: number; count: number }): RawEvent[] {
  const key = `${types.join(',')}\u0000${conversationId}`;
  const held = logs.get(key);
  let events: RawEvent[] | null = null;
  if (held && held.maxSeq <= version.maxSeq) {
    const added = held.maxSeq === version.maxSeq ? [] : getEvents(conversationId, { fromSeq: held.maxSeq + 1, types });
    if (held.events.length + added.length === version.count) events = added.length > 0 ? [...held.events, ...added] : held.events;
  }
  events ??= getEvents(conversationId, { types });
  touch(logs, key, { maxSeq: version.maxSeq, events }, MAX_LOGS);
  return events;
}

/**
 * `fold` over the conversation's events of `types`, recomputed only when an
 * event of those types has been added or removed. Returns a copy, so a caller
 * that mutates the result cannot change what the next caller gets; the fold
 * gets a copy of the events too, since they are kept for the next one.
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
    touch(entries, key, hit, MAX_ENTRIES);
    return globalThis.structuredClone(hit.value) as T;
  }
  const value = fold(globalThis.structuredClone(eventsOf(conversationId, types, version)));
  touch(entries, key, { ...version, value }, MAX_ENTRIES);
  return globalThis.structuredClone(value);
}

/** For tests. */
export function clearFoldCache(): void {
  entries.clear();
  logs.clear();
}
