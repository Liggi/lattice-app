/**
 * Unsupported provider contract.
 *
 * Contract: the public conversation API rejects unknown providers quickly with
 * `400 unsupported_provider`, instead of silently hanging or falling through.
 * Codex is now a supported provider; this protects the boundary for anything
 * outside the explicit provider set.
 */

import { test, expect } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

async function resetServer() {
  await fetch(`${BASE_URL}/api/test/reset`, { method: 'POST' });
}

test.describe('POST /api/conv/create — provider boundary', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('rejects unknown providers with 400 unsupported_provider', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    let resp: Response;
    try {
      resp = await fetch(`${BASE_URL}/api/conv/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          message: 'hello',
          workingDirectory: '/tmp',
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        `Request hung (no response within 5s) — server is silently dropping unsupported provider requests instead of rejecting them. ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error?: string; supportedProviders?: string[] };
    expect(body.error).toBe('unsupported_provider');
    expect(body.supportedProviders).toEqual(['claude', 'codex', 'opencode']);
  });

  test('accepts supported Codex text attachments and starts the conversation', async () => {
    const resp = await fetch(`${BASE_URL}/api/conv/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'codex',
        message: 'hello',
        workingDirectory: '/tmp',
        initialContent: [{ type: 'text', text: 'attached context' }],
      }),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      conversationId?: string;
      provider?: string;
      streamingId?: string;
    };
    expect(body.provider).toBe('codex');
    expect(body.conversationId).toMatch(/^conv-/);
    expect(body.streamingId).toBeTruthy();
  });
});
