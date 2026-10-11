/**
 * A plugin's `sessions.create`: a new conversation through the server's own
 * `POST /api/conv/create`, so it starts exactly as one from the New screen
 * does, with the same defaults and checks: the user's default Claude model,
 * as the New screen sends it, and a `title` set as a rename from the sidebar is.
 */

import os from 'os';
import { ConfigService } from '@/services/infrastructure/config-service.js';

function errorOf(body: { error?: string | { message?: string } }): string | undefined {
  return typeof body.error === 'string' ? body.error : body.error?.message;
}

export async function createPluginSession(opts: { message: string; title?: string; workingDirectory?: string; provider?: 'claude' | 'codex' }): Promise<{ conversationId: string }> {
  const config = ConfigService.getInstance().getConfig();
  const host = !config.server.host || config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
  const base = `http://${host}:${config.server.port}/api/conv`;
  const headers = {
    'content-type': 'application/json',
    ...(config.server.authToken ? { authorization: `Bearer ${config.server.authToken}` } : {}),
  };
  const provider = opts.provider ?? 'claude';
  const model = provider === 'claude' ? config.server.defaultModel : undefined;
  const response = await fetch(`${base}/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      provider,
      message: opts.message,
      workingDirectory: opts.workingDirectory ?? config.server.defaultWorkingDirectory ?? os.homedir(),
      ...(model ? { model } : {}),
    }),
  });
  const body = await response.json().catch(() => ({})) as { conversationId?: string; error?: string | { message?: string } };
  if (!response.ok || !body.conversationId) {
    throw new Error(`The session could not be started: ${errorOf(body) ?? `the server answered ${response.status}`}`);
  }
  if (opts.title?.trim()) {
    const named = await fetch(`${base}/${body.conversationId}/update`, { method: 'PUT', headers, body: JSON.stringify({ customName: opts.title.trim() }) });
    if (!named.ok) {
      const why = errorOf(await named.json().catch(() => ({})) as { error?: string });
      throw new Error(`The session ${body.conversationId} started but could not be named: ${why ?? `the server answered ${named.status}`}`);
    }
  }
  return { conversationId: body.conversationId };
}
