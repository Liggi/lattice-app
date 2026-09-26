/**
 * Voice routes — GPT Live alpha SDP broker.
 *
 * Endpoints:
 * - GET  /api/voice/status  - Readiness + model/voice the page should display
 * - POST /api/voice/session - Broker a WebRTC SDP offer to the Live API
 *
 * The browser holds the media path: microphone and response audio go directly
 * between the browser and OpenAI over WebRTC. This server only exchanges the
 * one-time SDP offer/answer so the alpha project key never reaches browser
 * code. Nothing here sits in the audio path, so it adds no speech latency.
 *
 * Delegation to Lattice sessions is deliberately NOT brokered here — the page
 * drives `POST /api/conv/create` and `GET /api/harness/:id/events` directly,
 * which are the existing documented surfaces for launching and streaming a
 * session.
 */

import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import { RequestWithRequestId } from '@/types/express.js';
import { CONFIG_DIR, CONFIG_FILE } from '@/utils/constants.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { asyncHandler } from '@/middleware/error-handler.js';
import { ConfigService } from '@/services/infrastructure/config-service.js';
import { parseJson } from '@/utils/json.js';
import type { ConversationService } from '@/services/sessions/conversation-service.js';
import type { SessionInfoService } from '@/services/sessions/session-info-service.js';
import type { LiveStatus } from '@/services/voice/voice-assist-service.js';
import { voiceTools, runVoiceTool } from '@/services/voice/voice-tools.js';
import { userName } from '../../services/user-profile.js';

const LIVE_API_URL = 'https://api.openai.com/v1/live';
const LIVE_MODEL = 'gpt-live-1-boulder-alpha';
const LIVE_VOICE = 'cedar';
const ALPHA_SELECTOR = 'quicksilver=v2';
const DELEGATE_MODEL = 'gpt-5.6-luna';

/**
 * The backend model behind the voice. It never speaks to the user directly — its
 * output is injected into the live session — so it is told to write the way the
 * voice needs to sound.
 */
function delegateInstructions(): string {
  return [
    `You answer questions about ${userName()}’s agentic coding sessions for a voice`,
    'assistant. Your reply is read out loud, so write plain spoken sentences: no',
    'markdown, no lists, no ids, no file paths, no PR numbers unless they asked.',
    '',
    'You do not know anything about their sessions on your own. Look before you',
    'answer, every time, and never guess or fill a gap with something plausible.',
    'If a lookup does not show something, say that you cannot see it rather than',
    'inventing it.',
    '',
    'list_sessions tells you what exists. read_session tells you what one has',
    'actually been doing — use it for any question about a specific session, and',
    'use it again on a follow-up rather than answering from what you already said.',
    'Chain them freely; they are waiting on one answer, not on your first tool call.',
    '',
    'Resolve which session they mean yourself, from their words and the conversation.',
    'Only ask them if two sessions genuinely fit.',
  ].join('\n');
}

/** The API rejects instructions over 16,384 tokens; 48k chars is well under. */
const MAX_INSTRUCTIONS_LENGTH = 48_000;
const MIN_SDP_LENGTH = 32;
const MAX_SDP_LENGTH = 100_000;

interface SessionBody {
  sdp?: unknown;
  instructions?: unknown;
  statuses?: unknown;
}

/** Live status arrives from the page, which already polls the canonical route. */
function readStatuses(raw: unknown): LiveStatus {
  return raw && typeof raw === 'object' ? (raw as LiveStatus) : {};
}

/**
 * The alpha key is a different key from `openai.apiKey` — only the Live-alpha
 * project key is enrolled. Env wins so the service can be run with a key that
 * is never written to disk.
 */
function resolveLiveApiKey(): string | undefined {
  const fromEnv = process.env.OPENAI_LIVE_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const config = ConfigService.getInstance().getConfig() as {
    openaiLive?: { apiKey?: string };
  };
  const fromConfig = config.openaiLive?.apiKey;
  return fromConfig && fromConfig.trim() ? fromConfig.trim() : undefined;
}

export function createVoiceRoutes(deps: {
  conversationService?: ConversationService;
  sessionInfoService?: SessionInfoService;
}): Router {
  const router = Router();
  const logger = createLogger('VoiceRoutes');

  // GET /api/voice/status - Is the alpha key configured?
  router.get('/status', (_req: RequestWithRequestId, res) => {
    res.json({
      ready: Boolean(resolveLiveApiKey()),
      model: LIVE_MODEL,
      voice: LIVE_VOICE,
    });
  });

  /**
   * POST /api/voice/tool - Execute one tool call from the Live session.
   *
   * The alpha returns client-actionable function calls over the data channel;
   * the page relays them here because the tools read the user's own machine. Reads
   * run in-process, so this is a local round trip rather than another model.
   */
  router.post('/tool', asyncHandler(async (req: RequestWithRequestId, res) => {
    const body = req.body as {
      name?: unknown;
      arguments?: unknown;
      statuses?: unknown;
      workingDirectory?: unknown;
    };

    const name = typeof body.name === 'string' ? body.name : '';
    if (!name) {
      res.status(400).json({ error: 'A tool name is required.' });
      return;
    }
    if (!deps.sessionInfoService) {
      res.status(503).json({ error: 'Session metadata is not available.' });
      return;
    }

    let args: Record<string, unknown> = {};
    if (typeof body.arguments === 'string' && body.arguments.trim()) {
      try {
        args = parseJson(body.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
    } else if (body.arguments && typeof body.arguments === 'object') {
      args = body.arguments as Record<string, unknown>;
    }

    const startedAt = Date.now();
    const output = await runVoiceTool(name, args, {
      sessionInfoService: deps.sessionInfoService,
      statuses: readStatuses(body.statuses),
      workingDirectory:
        typeof body.workingDirectory === 'string' && body.workingDirectory
          ? body.workingDirectory
          : process.cwd(),
    });

    logger.info('Voice tool executed', {
      requestId: req.requestId,
      name,
      elapsedMs: Date.now() - startedAt,
      outputChars: output.length,
    });
    res.json({ output });
  }));

  /**
   * POST /api/voice/log - Append protocol events and transcripts to disk.
   *
   * Voice is the one surface with no scrollback: once the tab closes the whole
   * conversation is gone, which makes "it seemed confused" impossible to
   * diagnose. Everything the data channel carries is appended as JSONL next to
   * the existing voice logs.
   */
  router.post('/log', asyncHandler(async (req: RequestWithRequestId, res) => {
    const body = req.body as { sessionId?: unknown; entries?: unknown };

    const sessionId =
      typeof body.sessionId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(body.sessionId)
        ? body.sessionId
        : null;
    if (!sessionId) {
      res.status(400).json({ error: 'A safe sessionId is required.' });
      return;
    }
    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      res.status(400).json({ error: 'entries must be a non-empty array.' });
      return;
    }

    const directory = path.join(CONFIG_DIR, 'voice-logs');
    await fs.mkdir(directory, { recursive: true });

    const lines = body.entries
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    await fs.appendFile(path.join(directory, `voice-${sessionId}.jsonl`), `${lines}\n`, 'utf8');

    res.json({ written: body.entries.length });
  }));

  // POST /api/voice/session - Exchange an SDP offer for the Live API's answer
  router.post('/session', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const body = req.body as SessionBody;

    if (
      typeof body.sdp !== 'string' ||
      body.sdp.length < MIN_SDP_LENGTH ||
      body.sdp.length > MAX_SDP_LENGTH
    ) {
      res.status(400).json({ error: 'A valid WebRTC SDP offer is required.' });
      return;
    }

    if (typeof body.instructions !== 'string' || !body.instructions.trim()) {
      res.status(400).json({ error: 'Session instructions are required.' });
      return;
    }

    const apiKey = resolveLiveApiKey();
    if (!apiKey) {
      res.status(503).json({
        error:
          `No GPT Live alpha key configured. Set OPENAI_LIVE_API_KEY or openaiLive.apiKey in ${CONFIG_FILE}.`,
      });
      return;
    }

    const instructions = body.instructions.trim().slice(0, MAX_INSTRUCTIONS_LENGTH);

    const form = new FormData();
    form.set('sdp', body.sdp);
    form.set(
      'session',
      JSON.stringify({
        model: LIVE_MODEL,
        instructions,
        audio: { output: { voice: LIVE_VOICE } },
        // Responses delegation: OpenAI runs the backend model with these tools
        // declared and hands client-actionable calls back over the data channel
        // for us to execute. Its answer is injected into the live session and
        // spoken, so the voice model never has to relay it.
        delegation: {
          type: 'responses',
          responses: {
            model: DELEGATE_MODEL,
            instructions: delegateInstructions(),
            tools: voiceTools(),
            tool_choice: 'auto',
            parallel_tool_calls: true,
            text: { verbosity: 'low' },
          },
        },
      }),
    );

    logger.info('Brokering Live session', { requestId, model: LIVE_MODEL });

    let upstream: Response;
    try {
      upstream = await fetch(LIVE_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Alpha': ALPHA_SELECTOR,
          Accept: 'application/sdp',
        },
        body: form,
      });
    } catch (err) {
      logger.error('Could not reach the Live API', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: 'Could not reach the OpenAI Live API.' });
      return;
    }

    const responseBody = await upstream.text();

    if (!upstream.ok) {
      logger.error('Live API rejected the session', {
        requestId,
        status: upstream.status,
        detail: responseBody.slice(0, 500),
      });
      res.status(upstream.status < 500 ? upstream.status : 502).json({
        error: 'OpenAI rejected the Live session request.',
        upstream_status: upstream.status,
        detail: responseBody.slice(0, 2000),
      });
      return;
    }

    res.json({
      sdp: responseBody,
      session_id: upstream.headers.get('OpenAI-Session-ID'),
      model: LIVE_MODEL,
    });
  }));

  return router;
}
