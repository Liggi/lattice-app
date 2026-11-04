import { createContext, useContext } from 'react';
import type { ImageBox, PendingAnnotation } from '../../utils/annotations-format';

/**
 * The conversation's pending notes, as the image viewer needs them: a box
 * drawn on a screenshot becomes a note that rides on the next message, like a
 * note on a highlighted passage. Absent where notes cannot be sent (the
 * viewer then offers no way to draw).
 */
export interface ImageNotesApi {
  notes: PendingAnnotation[];
  add: (input: { messageId: string; src: string; path?: string; label: string; box: ImageBox; note: string }) => void;
  update: (id: string, note: string) => void;
  remove: (id: string) => void;
}

export const ImageNotesContext = createContext<ImageNotesApi | null>(null);

export function useImageNotes(): ImageNotesApi | null {
  return useContext(ImageNotesContext);
}

/** The local path behind an image the server serves from disk, as the agent wrote it. */
export function imagePath(src: string): string | undefined {
  if (!src.startsWith('/api/images?')) return undefined;
  return new URLSearchParams(src.slice('/api/images?'.length)).get('path') ?? undefined;
}
