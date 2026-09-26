import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '../../src/services/process/codex-app-server-client.js';

type HandleLine = { handleLine(line: string): void };

const streamErrorNotification = JSON.stringify({
  jsonrpc: '2.0',
  method: 'error',
  params: {
    error: {
      message: 'Reconnecting... 2/5',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      additionalDetails:
        'stream disconnected before completion: websocket closed by server before response.completed',
    },
    willRetry: true,
    threadId: '019f56e2-6f15-7162-a53b-6eca25d238d3',
    turnId: '019f5709-e721-7560-97c2-fb951c4dd40e',
  },
});

describe('CodexAppServerClient error-notification handling', () => {
  it('dispatches a codex "error" notification without throwing (regression: ERR_UNHANDLED_ERROR crashed the server, 2026-07-12)', () => {
    const client = new CodexAppServerClient('test-client', '/tmp');
    const notificationHandler = vi.fn();
    client.on('notification', notificationHandler);

    expect(() =>
      (client as unknown as HandleLine).handleLine(streamErrorNotification),
    ).not.toThrow();

    expect(notificationHandler).toHaveBeenCalledTimes(1);
    expect(notificationHandler.mock.calls[0][0].method).toBe('error');
  });

  it('dispatches non-error notification methods', () => {
    const client = new CodexAppServerClient('test-client', '/tmp');
    const notificationHandler = vi.fn();
    client.on('notification', notificationHandler);

    expect(() =>
      (client as unknown as HandleLine).handleLine(
        JSON.stringify({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: {} }),
      ),
    ).not.toThrow();
    expect(notificationHandler).toHaveBeenCalledTimes(1);
  });
});

describe('CodexAppServerClient without Codex installed', () => {
  it('rejects the start with a not-installed error instead of crashing the server (2026-09-24)', async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'lattice-no-codex-'));
    const savedPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      const client = new CodexAppServerClient('no-codex', tmpdir());
      const exited = vi.fn();
      client.on('exit', exited);

      await expect(client.ensureStarted()).rejects.toMatchObject({ code: 'PROVIDER_NOT_INSTALLED', statusCode: 400 });
      expect(exited).toHaveBeenCalledTimes(1);
    } finally {
      process.env.PATH = savedPath;
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});
