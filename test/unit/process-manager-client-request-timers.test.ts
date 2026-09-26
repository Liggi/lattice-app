/**
 * Every IPC request armed a 185s timeout whose handle was never captured. The
 * response path deleted the pending entry without cancelling it, so each
 * spawn/send/status call pinned a live timer and its closure for ~3 minutes.
 *
 * Driven over a real Unix socket so the settle paths exercised are the ones
 * production uses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ProcessManagerClient } from '../../src/process-daemon/process-manager-client.js';

let tmpDir: string;
let socketPath: string;
let server: net.Server;
let client: ProcessManagerClient;

/** Timers armed by the client under test, ignoring anything pre-existing. */
function armedTimers(): number {
  return vi.getTimerCount();
}

function startServer(onRequest: (socket: net.Socket, request: { id: number; method: string }) => void): Promise<void> {
  server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        onRequest(socket, JSON.parse(line) as { id: number; method: string });
      }
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve()));
}

describe('ProcessManagerClient request timeouts', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-pmc-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    client?.disconnect();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clears the request timeout when a response arrives', async () => {
    await startServer((socket, request) => {
      socket.write(JSON.stringify({ id: request.id, result: { active: true } }) + '\n');
    });

    client = new ProcessManagerClient(socketPath);
    await client.connect();

    const before = armedTimers();
    await expect(client.isSessionActive('stream-1')).resolves.toBe(true);
    expect(armedTimers()).toBe(before);

    // Repeated calls must not accumulate handles either.
    for (let i = 0; i < 10; i++) {
      await client.isSessionActive(`stream-${i}`);
    }
    expect(armedTimers()).toBe(before);
  });

  it('clears the request timeout when the daemon returns an error', async () => {
    await startServer((socket, request) => {
      socket.write(JSON.stringify({
        id: request.id,
        error: { code: 'NOPE', message: 'no such session' },
      }) + '\n');
    });

    client = new ProcessManagerClient(socketPath);
    await client.connect();

    const before = armedTimers();
    await expect(client.stopConversation('stream-1')).rejects.toThrow('no such session');
    expect(armedTimers()).toBe(before);
  });

  it('still times out a request the daemon never answers', async () => {
    await startServer(() => { /* deliberate silence */ });

    client = new ProcessManagerClient(socketPath);
    await client.connect();

    const pending = client.isSessionActive('stream-quiet');
    const rejected = expect(pending).rejects.toThrow('timed out');

    await vi.advanceTimersByTimeAsync(185_000);
    await rejected;

    expect(armedTimers()).toBe(0);
  });
});
