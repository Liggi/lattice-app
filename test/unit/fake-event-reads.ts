/**
 * The repository's event reads over an in-memory log, for tests that mock
 * `session-history/repository.js`. Honours the same filters as the SQL, so a
 * caller that reads only what it needs is tested on exactly that.
 */

import type { RawEvent } from '../../src/session-history/types.js';
import type { EventQueryOptions } from '../../src/session-history/repository.js';

export function fakeEventReads(logOf: (conversationId: string) => readonly RawEvent[]) {
  const getEvents = (conversationId: string, opts: EventQueryOptions = {}): RawEvent[] =>
    logOf(conversationId).filter((event) => (opts.fromSeq === undefined || event.seq >= opts.fromSeq)
      && (opts.toSeq === undefined || event.seq <= opts.toSeq)
      && (!opts.types || opts.types.length === 0 || opts.types.includes(event.type)));
  return {
    getEvents,
    getEventsVersion: (conversationId: string, types: readonly string[]) => {
      const events = getEvents(conversationId, { types });
      return { maxSeq: Math.max(0, ...events.map((event) => event.seq)), count: events.length };
    },
    getEvent: (conversationId: string, seq: number) => logOf(conversationId).find((event) => event.seq === seq) ?? null,
    iterateEventsNewestFirst: (conversationId: string, types: readonly string[]) =>
      getEvents(conversationId, { types }).reverse()[Symbol.iterator](),
  };
}
