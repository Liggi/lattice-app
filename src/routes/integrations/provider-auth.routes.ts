import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { requireTrustedOrigin } from '@/middleware/trusted-origin.js';
import type { RequestWithRequestId } from '@/types/express.js';
import { getProviderAuthService } from '@/services/provider-auth-service.js';
import type { ProcessManagerClient } from '@/process-daemon/process-manager-client.js';
import type { LoginTerminalOutputEventData, LoginTerminalStateEventData } from '@/process-daemon/types.js';
import { LatticeError } from '@/types/index.js';
import { createLogger } from '@/services/infrastructure/logger.js';

const logger = createLogger('ProviderAuthRoutes');

const SSE_KEEPALIVE_MS = 15_000;

export interface ProviderAuthRouteDeps {
  /** Owns the sign-in terminal. Without it Claude status and logout still work; sign-in reports why it cannot. */
  processManagerClient?: ProcessManagerClient;
}

function requireDaemon(deps: ProviderAuthRouteDeps): ProcessManagerClient {
  if (!deps.processManagerClient?.isConnected()) {
    throw new LatticeError('DAEMON_NOT_CONNECTED', 'The process daemon is not running, so Claude sign-in cannot start', 503);
  }
  return deps.processManagerClient;
}

function attemptIdOf(req: Request): string {
  const attemptId = req.params.attemptId;
  if (typeof attemptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(attemptId)) {
    throw new LatticeError('INVALID_ATTEMPT_ID', 'Invalid sign-in attempt id', 400);
  }
  return attemptId;
}

/**
 * The sign-in screen, over Server-Sent Events. The daemon replays what the
 * terminal has shown so far, then the live chunks follow; a chunk the replay
 * already covered is recognised by its offset and skipped, so a phone that
 * reconnects mid-sentence sees each character once.
 *
 * Nothing sent here is logged: the frames carry the CLI's screen, including
 * the echo of whatever the person pastes into it.
 */
async function streamLoginTerminal(client: ProcessManagerClient, attemptId: string, res: Response): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, payload: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  let replayEnd: number | null = null;
  const heardEarly: LoginTerminalOutputEventData[] = [];
  const onOutput = (data: LoginTerminalOutputEventData): void => {
    if (data.attemptId !== attemptId) return;
    if (replayEnd === null) {
      heardEarly.push(data);
      return;
    }
    if (data.offset >= replayEnd) send('output', { data: data.data });
  };
  const onState = (data: LoginTerminalStateEventData): void => {
    if (data.attemptId !== attemptId) return;
    send('state', data.state);
  };
  client.on('login-terminal-output', onOutput);
  client.on('login-terminal-state', onState);

  const keepAlive = setInterval(() => { res.write(': keep-alive\n\n'); }, SSE_KEEPALIVE_MS);
  const cleanup = (): void => {
    clearInterval(keepAlive);
    client.removeListener('login-terminal-output', onOutput);
    client.removeListener('login-terminal-state', onState);
  };
  res.on('close', cleanup);

  try {
    const attached = await client.attachLoginTerminal(attemptId);
    // `replay` rather than `output`: a reconnecting browser clears its screen
    // before drawing this, so the history is not appended under itself.
    send('replay', { data: attached.output });
    replayEnd = attached.outputEnd;
    for (const chunk of heardEarly) {
      if (chunk.offset >= replayEnd) send('output', { data: chunk.data });
    }
    heardEarly.length = 0;
    send('state', attached.state);
  } catch (error) {
    send('error', { error: error instanceof Error ? error.message : 'Could not attach to the sign-in terminal' });
    cleanup();
    res.end();
  }
}

export function createProviderAuthRoutes(deps: ProviderAuthRouteDeps = {}): Router {
  const router = Router();

  router.get('/claude/status', asyncHandler(async (_req, res) => {
    const authService = getProviderAuthService();
    res.json(await authService.getClaudeAuthStatus());
  }));

  // Claude's own sign-in, in a terminal the daemon owns. The browser types
  // into it and reads its screen; Lattice never sees a URL or a code as such.
  // Every route that starts, reads or types into it refuses other origins:
  // possession of the page is the credential here.
  router.post('/claude/login-terminal', requireTrustedOrigin, asyncHandler(async (req: RequestWithRequestId<{ cols?: number; rows?: number; restart?: boolean }>, res) => {
    const client = requireDaemon(deps);
    const { cols, rows, restart } = req.body ?? {};
    const result = await client.startLoginTerminal({ size: { cols, rows }, restart: restart === true });
    logger.info('Claude sign-in terminal requested', { attemptId: result.attemptId, reused: result.reused });
    res.json(result);
  }));

  router.get('/claude/login-terminal/:attemptId/stream', requireTrustedOrigin, asyncHandler(async (req, res) => {
    await streamLoginTerminal(requireDaemon(deps), attemptIdOf(req), res);
  }));

  router.get('/claude/login-terminal/:attemptId', requireTrustedOrigin, asyncHandler(async (req, res) => {
    res.json({ state: await requireDaemon(deps).getLoginTerminalState(attemptIdOf(req)) });
  }));

  router.post('/claude/login-terminal/:attemptId/input', requireTrustedOrigin, asyncHandler(async (req: RequestWithRequestId<{ clientId?: string; seq?: number; data?: string }>, res) => {
    const { clientId, seq, data } = req.body ?? {};
    if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 64) {
      throw new LatticeError('INVALID_INPUT', 'Missing clientId', 400);
    }
    if (typeof seq !== 'number' || typeof data !== 'string') {
      throw new LatticeError('INVALID_INPUT', 'Input needs a seq and data', 400);
    }
    res.json(await requireDaemon(deps).sendLoginTerminalInput(attemptIdOf(req), clientId, seq, data));
  }));

  router.post('/claude/login-terminal/:attemptId/resize', requireTrustedOrigin, asyncHandler(async (req: RequestWithRequestId<{ cols?: number; rows?: number }>, res) => {
    const { cols, rows } = req.body ?? {};
    await requireDaemon(deps).resizeLoginTerminal(attemptIdOf(req), { cols, rows });
    res.json({ success: true });
  }));

  router.delete('/claude/login-terminal/:attemptId', requireTrustedOrigin, asyncHandler(async (req, res) => {
    res.json({ cancelled: await requireDaemon(deps).cancelLoginTerminal(attemptIdOf(req)) });
  }));

  router.post('/claude/logout', asyncHandler(async (_req, res) => {
    const authService = getProviderAuthService();
    const result = await authService.logoutClaude();
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json(result);
  }));

  router.get('/codex/status', asyncHandler(async (_req, res) => {
    const authService = getProviderAuthService();
    res.json(await authService.getCodexAuthStatus());
  }));

  // Device-code flow: Codex prints a URL + one-time code and polls OpenAI
  // itself, so the client only needs to show them and poll for completion.
  router.post('/codex/login', asyncHandler(async (_req: RequestWithRequestId, res) => {
    const authService = getProviderAuthService();
    res.json(await authService.startCodexDeviceLogin());
  }));

  router.get('/codex/login/:sessionId', asyncHandler(async (req, res) => {
    const authService = getProviderAuthService();
    const state = authService.getCodexDeviceLoginState(req.params.sessionId);
    if (!state) {
      res.status(404).json({ error: 'Codex login session not found or expired' });
      return;
    }
    res.json(state);
  }));

  router.delete('/codex/login/:sessionId', asyncHandler(async (req, res) => {
    const authService = getProviderAuthService();
    res.json({ cancelled: authService.cancelCodexDeviceLogin(req.params.sessionId) });
  }));

  router.post('/codex/logout', asyncHandler(async (_req, res) => {
    const authService = getProviderAuthService();
    const result = await authService.logoutCodex();
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json(result);
  }));

  return router;
}
