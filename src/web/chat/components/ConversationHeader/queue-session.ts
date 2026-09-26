import type { DevNote, StoredRecommendation } from '../../types';
import { parseJson } from '../../../../utils/json.js';
import type { Provider } from '@/types/unified-messages';

const QUEUE_SESSION_DRAFT_STORAGE_KEY = 'lattice-queued-session-last-prompt';
type QueueProvider = Provider;

export interface CreateConversationResponse {
  conversationId: string;
  segmentId: string;
  streamingId: string;
  streamUrl: string;
  sessionId: string;
  provider: QueueProvider;
  cwd: string;
  model: string;
  permissionMode?: string;
  threadId?: string;
}

export interface QueueSessionApi {
  createConversation: (params: {
    provider: QueueProvider;
    message: string;
    workingDirectory: string;
    model?: string;
    permissionMode?: string;
    workspace?: string;
  }) => Promise<CreateConversationResponse>;
  updateDevNoteStatus?: (id: string, status: 'done' | 'dismissed') => Promise<unknown>;
  completeRecommendation?: (id: string) => Promise<unknown>;
}

export interface LaunchQueueSessionOptions {
  workspace?: string;
  provider?: QueueProvider;
  model?: string;
  permissionMode?: string;
}

export interface StoredQueueSessionDraft {
  prompt: string;
  provider: QueueProvider;
  model?: string;
  workspace?: string;
  workingDirectory: string;
  permissionMode?: string;
  createdAt: string;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return null;
  }
  return window.localStorage;
}

function persistQueueSessionDraft(draft: StoredQueueSessionDraft): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(QUEUE_SESSION_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Best-effort storage only.
  }
}

export function readQueueSessionDraft(): StoredQueueSessionDraft | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(QUEUE_SESSION_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = parseJson(raw) as Partial<StoredQueueSessionDraft>;
    if (!parsed || typeof parsed.prompt !== 'string' || typeof parsed.provider !== 'string') {
      return null;
    }
    return {
      prompt: parsed.prompt,
      provider: parsed.provider === 'codex' ? 'codex' : 'claude',
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      workspace: typeof parsed.workspace === 'string' ? parsed.workspace : undefined,
      workingDirectory: typeof parsed.workingDirectory === 'string' ? parsed.workingDirectory : '~',
      permissionMode: typeof parsed.permissionMode === 'string' ? parsed.permissionMode : undefined,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function buildQueueSessionPrompt(notes: DevNote[], recommendations: StoredRecommendation[]): string {
  const orderedNotes = [...notes].sort((a, b) => (
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ));

  let prompt = '';

  if (orderedNotes.length > 0) {
    prompt += `You have ${notes.length} dev note${notes.length !== 1 ? 's' : ''} to work through.\n\n`;

    for (const note of orderedNotes) {
      prompt += `- ${note.content}\n`;
    }
    prompt += '\n';
  }

  if (recommendations.length > 0) {
    if (notes.length > 0) {
      prompt += `---\n\n`;
    }
    prompt += `You also have ${recommendations.length} recommendation${recommendations.length !== 1 ? 's' : ''} from session analysis:\n\n`;

    for (const rec of recommendations) {
      prompt += `### ${rec.target} (id: ${rec.id})\n`;
      prompt += `- **Friction**: ${rec.friction}\n`;
      prompt += `- **Action**: ${rec.action}\n`;
      if (rec.rationale) {
        prompt += `- **Rationale**: ${rec.rationale}\n`;
      }
      prompt += '\n';
    }

    prompt += `When you complete a recommendation, mark it done by running:
  curl -s -X POST http://localhost:3001/api/insights/recommendations/<REC_ID>/complete\n\n`;
  }

  if (orderedNotes.length > 0) {
    prompt += `\nDev-note completion discipline (required):
- Keep a running checklist of the dev notes above.
- As soon as you complete a dev note, mark it done by running:
  curl -s -X PATCH http://localhost:3001/api/notes/<NOTE_ID> -H 'Content-Type: application/json' -d '{"status":"done"}'
- Note IDs: ${orderedNotes.map(n => `"${n.content.slice(0, 50)}..." → ${n.id}`).join(', ')}
- Do not wait until the end to check off notes; mark them as you go.
- End each substantial update with two short lists: "Completed this turn" and "Still pending".\n`;
  }

  prompt += `\nPlease work through these notes systematically. For each one, either:
1. Implement the fix/change if straightforward
2. Investigate and propose a solution if complex
3. Ask clarifying questions if the note is ambiguous

Mark each note as addressed as you complete it.`;

  return prompt;
}

export async function launchQueueSession(
  apiClient: QueueSessionApi,
  notes: DevNote[],
  recommendations: StoredRecommendation[],
  homeDirectory: string,
  options: LaunchQueueSessionOptions = {}
): Promise<CreateConversationResponse | null> {
  if (notes.length === 0 && recommendations.length === 0) return null;

  const prompt = buildQueueSessionPrompt(notes, recommendations);
  const provider = options.provider || 'claude';
  const model = options.model;

  persistQueueSessionDraft({
    prompt,
    provider,
    model,
    workspace: options.workspace,
    workingDirectory: homeDirectory,
    permissionMode: options.permissionMode,
    createdAt: new Date().toISOString(),
  });

  return apiClient.createConversation({
    provider,
    message: prompt,
    workingDirectory: homeDirectory,
    model,
    permissionMode: options.permissionMode,
    workspace: options.workspace,
  });
}
