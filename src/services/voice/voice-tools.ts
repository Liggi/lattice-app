/**
 * Tools the GPT Live model calls directly.
 *
 * The alpha's Responses delegation runs a backend model server-side with these
 * declared, and hands client-actionable calls back to us over the data channel
 * to execute. That replaces the hand-rolled `gpt-live -> luna -> tools` chain:
 * OpenAI owns the loop, the backend model can chain several calls to answer one
 * question, and its answer is injected into the live session and spoken without
 * the voice model having to relay it.
 *
 * Declarations live here next to the implementations so the two cannot drift.
 */

import { createLogger } from '@/services/infrastructure/logger.js';
import { ConfigService } from '@/services/infrastructure/config-service.js';
import {
  collectFleet,
  readSessionTranscript,
  renderFleetForModel,
  type VoiceAssistDeps,
} from './voice-assist-service.js';
import { userName } from '../user-profile.js';

const logger = createLogger('VoiceTools');

/** This server's own API, at the address and port its config binds. */
function serverApiUrl(path: string): string {
  const { host, port } = ConfigService.getInstance().getConfig().server;
  // A wildcard bind answers on loopback; an IPv6 literal needs brackets in a URL.
  const dialHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${dialHost.includes(':') ? `[${dialHost}]` : dialHost}:${port}${path}`;
}

/** Tool results are read aloud after summarising, so they stay compact. */
const MAX_TOOL_OUTPUT_CHARS = 6000;

export interface VoiceToolDeclaration {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * What the backend model can do.
 *
 * `read_session` deliberately takes a plain-English `session` rather than a
 * conv- id: the model is answering speech like "the image eval one", and making
 * it carry ids around is how the old design ended up asking the user which session
 * they meant.
 */
export function voiceTools(): VoiceToolDeclaration[] {
  return [
    {
      type: 'function',
      name: 'list_sessions',
      description:
        `List ${userName()}’s coding sessions: what each is working on, whether it is running, ` +
        'waiting on them, or finished, and how long since it last did anything. Call ' +
        'this first for anything about the fleet as a whole.',
      parameters: {
        type: 'object',
        properties: {
          activeOnly: { type: 'boolean', description: 'Only sessions currently running.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'read_session',
      description:
        'Read what one session has actually said and done recently — its own words, in ' +
        'order, and the tools it ran. Use this for "what is it doing", "where did it get ' +
        'to", "what did it find", and any follow-up about a specific session.',
      parameters: {
        type: 'object',
        properties: {
          session: {
            type: 'string',
            description:
              `Which session, in plain words as ${userName()} said it — "the image eval one", ` +
              '"prompt injection". A conv- id also works.',
          },
          turns: { type: 'number', description: 'How many recent turns. Default 12.' },
        },
        required: ['session'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'send_to_session',
      description:
        `Send a message into one of ${userName()}’s sessions, on their behalf. Only when they have ` +
        'plainly asked for it — "tell it to…", "ask it to…", "get it to stop".',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Which session, in plain words or by conv- id.' },
          message: { type: 'string', description: 'What to say to it, plain imperative English.' },
        },
        required: ['session', 'message'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'start_session',
      description: `Start a new coding session on a task ${userName()} has described.`,
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task, restated clearly.' },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
  ];
}

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS - 1)}…`
    : text;
}

/**
 * Resolve "the image eval one" to a conversation.
 *
 * Scores each session's label and Argus context against the spoken words. An id
 * is matched outright; otherwise the best word overlap wins, and running
 * sessions break ties because they are what the user is most likely talking about.
 */
function resolveSession(
  spoken: string,
  rows: Awaited<ReturnType<typeof collectFleet>>,
): (typeof rows)[number] | null {
  const needle = spoken.trim().toLowerCase();
  if (!needle) return null;

  const byId = rows.find((row) => row.conversationId.toLowerCase() === needle);
  if (byId) return byId;

  const words = needle.split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  if (words.length === 0) return null;

  let best: { row: (typeof rows)[number]; score: number } | null = null;
  for (const row of rows) {
    const haystack = `${row.label} ${row.context ?? ''} ${row.theme ?? ''}`.toLowerCase();
    let score = words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
    if (score > 0 && row.running) score += 0.5;
    if (score > 0 && (!best || score > best.score)) best = { row, score };
  }
  return best?.row ?? null;
}

export interface VoiceToolContext extends VoiceAssistDeps {
  workingDirectory: string;
  /** Conversations started from voice, so they can be reported back accurately. */
  onSessionStarted?: (conversationId: string) => void;
}

/**
 * Run one tool call and return text for the model to answer from.
 *
 * Every failure returns a sentence rather than throwing: the model is mid-answer
 * with the user waiting, and "I could not read that session" is recoverable where a
 * dropped tool call leaves it silent or guessing.
 */
export async function runVoiceTool(
  name: string,
  args: Record<string, unknown>,
  context: VoiceToolContext,
): Promise<string> {
  const deps: VoiceAssistDeps = {
    sessionInfoService: context.sessionInfoService,
    statuses: context.statuses,
  };

  try {
    switch (name) {
      case 'list_sessions': {
        const rows = await collectFleet(deps, {
          limit: 25,
          activeOnly: args.activeOnly === true,
        });
        return clip(renderFleetForModel(rows, Date.now()));
      }

      case 'read_session': {
        const rows = await collectFleet(deps, { limit: 25 });
        const row = resolveSession(String(args.session ?? ''), rows);
        if (!row) {
          return `No session matches "${String(args.session ?? '')}". Sessions available:\n${renderFleetForModel(rows, Date.now())}`;
        }
        const turns = typeof args.turns === 'number' ? args.turns : 12;
        return clip(
          [
            `Session: ${row.label}`,
            row.context ? `What it is doing: ${row.context}` : '',
            row.arrow ? `Its next step: ${row.arrow}` : '',
            `Status: ${row.running ? 'running now' : row.status === 'idle' ? `open, waiting on ${userName()}` : 'finished'}`,
            '',
            'Its recent words, oldest first:',
            readSessionTranscript(row.conversationId, turns),
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      case 'send_to_session': {
        const rows = await collectFleet(deps, { limit: 25 });
        const row = resolveSession(String(args.session ?? ''), rows);
        if (!row) return `No session matches "${String(args.session ?? '')}", so nothing was sent.`;

        const message = String(args.message ?? '').trim();
        if (!message) return 'No message was given, so nothing was sent.';

        const response = await fetch(
          serverApiUrl(`/api/conv/${encodeURIComponent(row.conversationId)}/resume`),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
          },
        );
        if (!response.ok) return `The message could not be sent (HTTP ${response.status}).`;
        return `Sent into the session working on ${row.label}.`;
      }

      case 'start_session': {
        const task = String(args.task ?? '').trim();
        if (!task) return 'No task was given, so no session was started.';

        const response = await fetch(
          serverApiUrl('/api/conv/create'),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: 'claude',
              message: task,
              workingDirectory: context.workingDirectory,
            }),
          },
        );
        if (!response.ok) return `The session could not be started (HTTP ${response.status}).`;
        const created = (await response.json()) as { conversationId?: string };
        if (created.conversationId) context.onSessionStarted?.(created.conversationId);
        return `Started a new session on it.`;
      }

      default:
        return `There is no tool called ${name}.`;
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    logger.error('Voice tool failed', { name, error: message });
    return `That lookup failed: ${message}`;
  }
}
