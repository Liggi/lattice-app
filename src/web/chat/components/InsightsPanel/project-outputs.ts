import type { ChatMessage } from '../../types';
import type { WorkerReportedData } from '@/types/worker-events';
import { outputsFromSources, type OutputImage, type OutputSource, type ProjectOutputs } from '@/services/sessions/project-outputs-index';

export type { OutputImage, OutputLink, ProjectOutputs } from '@/services/sessions/project-outputs-index';
export { mergeOutputs } from '@/services/sessions/project-outputs-index';

function messageText(message: ChatMessage): string {
  if (message.type === 'system' && message.workerEvent?.type === 'worker:reported') {
    return (message.workerEvent.data as WorkerReportedData).text ?? '';
  }
  if (message.type !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n\n');
}

function* newestFirst(messages: ChatMessage[]): Generator<OutputSource> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    yield { messageId: message.messageId, text: messageText(message) };
  }
}

/**
 * What the loaded messages have produced, newest first: the screenshots its
 * agents showed and the pull requests they linked. The server reads the same
 * from the whole log (`GET /api/conv/:id/outputs`).
 */
export function extractOutputs(messages: ChatMessage[]): ProjectOutputs {
  return outputsFromSources(newestFirst(messages));
}

const CAPTION_BREAK = /\s+[—–]\s+|:\s+|\.\s+/;

function captionLead(caption: string): string {
  const trimmed = caption.trim();
  const match = CAPTION_BREAK.exec(trimmed);
  if (!match || match.index < 3) return trimmed;
  const lead = trimmed.slice(0, match.index).trim();
  return /^\d+$/.test(lead) ? trimmed : lead;
}

/**
 * Short tile labels for the Outputs thumbnail grid. Gallery captions are often
 * full sentences ("Title — detailed explanation"), so each tile uses the lead
 * clause when it stays distinct from the other shown tiles; colliding leads
 * keep their full caption (which the grid still clamps to a single line).
 */
export function outputCaptionLabels(images: readonly Pick<OutputImage, 'caption'>[]): string[] {
  const leads = images.map((image) => captionLead(image.caption));
  const counts = new Map<string, number>();
  for (const lead of leads) {
    const key = lead.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return images.map((image, index) => {
    const lead = leads[index]!;
    return (counts.get(lead.toLowerCase()) ?? 0) > 1 ? image.caption.trim() : lead;
  });
}
