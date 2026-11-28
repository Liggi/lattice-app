import { createContext } from 'react';
import type { WorkerGlyph } from './SessionStateIcon';
import type { WorkerCardState } from '@/types/worker-events';

/** The worker's kind as a glyph: the chief of staff, a worker on Fable, or an ordinary worker (the plain cube). */
export function workerGlyph(worker: Pick<WorkerCardState, 'model' | 'role'>): WorkerGlyph | undefined {
  if (worker.role?.chiefOfStaff) return { shape: 'bulb' };
  if (worker.model?.startsWith('claude-fable')) return { shape: 'upgraded-cube' };
  return undefined;
}

/**
 * The coordinator's workers by id, so a worker's card in the thread draws the
 * same glyph as its row in the panel: its role is known only from the workers
 * endpoint, not from the event.
 */
export const WorkersByIdContext = createContext<ReadonlyMap<string, Pick<WorkerCardState, 'model' | 'role'>>>(new Map());
