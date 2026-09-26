/**
 * Settling a message steered into a Claude turn whose process died before the
 * turn took it.
 *
 * Claude acknowledges a steered message as soon as its queue holds it
 * (`command_lifecycle: queued`), and only a later `started` says a turn read
 * it. The queue lives in the CLI's memory: a process killed in between — a
 * server restart, a Stop, a crash — takes the message with it, and `--resume`
 * does not bring it back (conv-l7QfLDca1s0J, 2026-09-26: a message queued
 * behind a /compact at 10:51 sat held for 40 minutes while the resumed
 * session ran two turns without it). The inbox rows stay reserved, so
 * nothing ever sends it.
 *
 * What the model read is what Claude wrote to its transcript, and once no
 * process is running that file is final. So when the process is gone, the
 * transcript settles the delivery: the text the delivery sent appears as a
 * user message, and the rows are marked read; it does not, and the rows go
 * back to the drain. A delivery whose sent text or transcript cannot be
 * found is left held for a person (`debug-held-deliveries.routes.ts`).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseJson } from '../../utils/json.js';
import { createLogger } from '../infrastructure/logger.js';
import { getEvent, iterateEventsNewestFirst } from '../../session-history/repository.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { INBOX_READ_EVENT, type InboxReadData } from '../../types/inbox.js';
import type { InputDeliveredData } from '../../types/immediate-delivery.js';
import { heldInboxReservations, markInboxItemsRead, releaseInboxReservation, type InboxRow } from './session-inbox.js';

const logger = createLogger('HeldDeliverySettlement');

const TAIL_START_BYTES = 4 * 1024 * 1024;

/**
 * Settle every held delivery of `sessionId` (every session when omitted).
 * The caller guarantees no process is running for those sessions. Never rejects.
 */
export async function settleHeldDeliveries(sessionId?: string): Promise<{ delivered: number; released: number }> {
  const settled = { delivered: 0, released: 0 };
  try {
    const byReservation = new Map<string, InboxRow[]>();
    for (const row of heldInboxReservations(sessionId)) {
      const rows = byReservation.get(row.reserved_by!) ?? [];
      rows.push(row);
      byReservation.set(row.reserved_by!, rows);
    }
    for (const [reservationId, rows] of byReservation) {
      const outcome = await settleOne(reservationId, rows);
      if (outcome) settled[outcome] += 1;
    }
  } catch (err) {
    logger.error('Settling held deliveries failed', err instanceof Error ? err : new Error(String(err)), { sessionId });
  }
  return settled;
}

async function settleOne(reservationId: string, rows: InboxRow[]): Promise<'delivered' | 'released' | null> {
  const sessionId = rows[0].session_id;
  const sent = sentInput(sessionId, reservationId);
  const transcript = sent ? await findTranscript(sessionId) : null;
  if (!sent || !transcript) {
    logger.warn('Held delivery left for a person: its sent text or transcript is not on record', {
      sessionId, reservationId, sentKnown: Boolean(sent), transcript,
    });
    return null;
  }
  const since = Date.parse(rows[0].reserved_at ?? rows[0].created_at);
  const read = transcriptHasUserText(await transcriptSince(transcript, since), sent.text);
  const ids = rows.map((row) => row.id);
  if (read) {
    const manager = getHarnessSessionManager();
    const event = manager
      ? appendCustomHarnessEvent(manager, sessionId, INBOX_READ_EVENT, { ids, sentSeq: sent.seq } satisfies InboxReadData)
      : null;
    markInboxItemsRead(ids, event?.seq ?? null);
  } else {
    releaseInboxReservation(reservationId);
  }
  logger.info(read
    ? 'Held delivery settled as read: the transcript has it'
    : 'Held delivery released: the process died before a turn took it', { sessionId, reservationId, items: ids.length });
  return read ? 'delivered' : 'released';
}

/** The `input:sent` a delivery went out on, from its `input:delivered` receipt. */
function sentInput(sessionId: string, reservationId: string): { seq: number; text: string } | null {
  for (const event of iterateEventsNewestFirst(sessionId, ['input:delivered'])) {
    const data = event.data as Partial<InputDeliveredData>;
    if (data.reservationId !== reservationId) continue;
    if (typeof data.sentSeq !== 'number') return null;
    const text = (getEvent(sessionId, data.sentSeq)?.data as { text?: unknown } | undefined)?.text;
    return typeof text === 'string' && text.length > 0 ? { seq: data.sentSeq, text } : null;
  }
  return null;
}

/** Claude's transcript file for the provider session this conversation last ran. */
async function findTranscript(sessionId: string): Promise<string | null> {
  let resumeId: string | null = null;
  for (const event of iterateEventsNewestFirst(sessionId, ['run:ready'])) {
    const id = (event.data as { resumeId?: unknown }).resumeId;
    if (typeof id === 'string' && id) { resumeId = id; break; }
  }
  if (!resumeId) return null;
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let dirs: string[];
  try { dirs = await fs.readdir(projects); } catch { return null; }
  for (const dir of dirs) {
    const file = path.join(projects, dir, `${resumeId}.jsonl`);
    try { await fs.access(file); return file; } catch { /* not in this project */ }
  }
  return null;
}

/**
 * The transcript's lines, back to at least `since`. Read from the end in growing
 * windows, since these files run to hundreds of megabytes and the delivery
 * is almost always near the end.
 */
async function transcriptSince(file: string, since: number): Promise<string[]> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    for (let window = TAIL_START_BYTES; ; window *= 4) {
      const start = Math.max(0, size - window);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      const first = lines.find((line) => line.includes('"timestamp"'));
      const firstAt = first ? Date.parse(/"timestamp":"([^"]+)"/.exec(first)?.[1] ?? '') : NaN;
      if (start === 0 || (Number.isFinite(firstAt) && firstAt < since)) return lines;
    }
  } finally {
    await handle.close();
  }
}

/** Whether a user message in these lines carries `text`. A queue entry is not a read. Exported for tests. */
export function transcriptHasUserText(lines: readonly string[], text: string): boolean {
  for (const line of lines) {
    if (!line.includes('"type":"user"')) continue;
    let record: { type?: string; message?: { content?: unknown } } | null;
    try { record = parseJson(line) as typeof record; } catch { continue; }
    if (record?.type !== 'user') continue;
    const content = record.message?.content;
    if (typeof content === 'string' && content.includes(text)) return true;
    if (Array.isArray(content) && content.some((block) =>
      typeof (block as { text?: unknown })?.text === 'string' && (block as { text: string }).text.includes(text))) return true;
  }
  return false;
}
