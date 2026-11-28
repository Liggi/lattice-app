/**
 * A conversation's outputs (screenshots shown, pull requests linked) read
 * from its whole event log, newest first, for `GET /api/conv/:id/outputs`.
 * The browser only holds the tail of a long conversation, so without this
 * the panel's Outputs lose anything older than the loaded messages.
 */

import { iterateEventsNewestFirst } from '../../session-history/repository.js';
import type { RawEvent } from '../../session-history/types.js';
import * as fs from 'fs';
import { findCachedImage, isTempPath, persistTempImage, type TempImageCacheOptions } from '../images/temp-image-cache.js';
import { OutputCollector, type OutputCollectorOptions, type ProjectOutputs } from './project-outputs-index.js';

const OUTPUT_EVENT_TYPES = ['content', 'worker:reported'] as const;
/** At most this many events are read; a long conversation stops here even when the lists are not full. */
const SCAN_LIMIT = 20_000;

/**
 * Outputs from events given newest first. Streamed text arrives as several
 * content events under one message id, so each message's text is rejoined
 * before it is read.
 */
export function outputsFromEvents(
  events: Iterable<RawEvent>,
  scanLimit = SCAN_LIMIT,
  options: OutputCollectorOptions = {},
): ProjectOutputs {
  const collector = new OutputCollector(options);
  let pending: { messageId: string; parts: string[] } | null = null;
  const flush = () => {
    if (pending) collector.add({ messageId: pending.messageId, text: pending.parts.reverse().join('') });
    pending = null;
  };
  let scanned = 0;
  for (const event of events) {
    if (++scanned > scanLimit || collector.full) break;
    const data = (event.data ?? {}) as { messageId?: unknown; blocks?: unknown; text?: unknown };
    if (event.type === 'worker:reported') {
      flush();
      if (typeof data.text === 'string') collector.add({ messageId: `seq-${event.seq}`, text: data.text });
      continue;
    }
    const blocks = Array.isArray(data.blocks) ? data.blocks as Array<{ type?: string; text?: unknown }> : [];
    const text = blocks.map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('');
    if (!text) continue;
    const messageId = typeof data.messageId === 'string' ? data.messageId : `seq-${event.seq}`;
    if (pending && pending.messageId !== messageId) flush();
    pending ??= { messageId, parts: [] };
    pending.parts.push(text);
  }
  flush();
  return collector.result();
}

/**
 * Whether an image can still be shown: its file is on disk, or a copy was
 * kept of it from a temp directory. A temp image still on disk is copied now,
 * so it outlasts the next clear-out even if nobody opened it.
 */
export function imageStillShown(p: string, opts: TempImageCacheOptions = {}): boolean {
  let onDisk = false;
  try {
    onDisk = fs.statSync(p).isFile();
  } catch { /* gone */ }
  if (!isTempPath(p, opts)) return onDisk;
  if (onDisk) {
    persistTempImage(p, opts);
    return true;
  }
  return findCachedImage(p, opts) !== null;
}

export function readConversationOutputs(conversationId: string, opts: TempImageCacheOptions = {}): ProjectOutputs {
  return outputsFromEvents(iterateEventsNewestFirst(conversationId, OUTPUT_EVENT_TYPES), SCAN_LIMIT, {
    acceptImage: (p) => imageStillShown(p, opts),
  });
}
