/**
 * The daemon stopped under a running server (2026-09-27) and the client only
 * retried its socket, so every spawn failed with "Not connected to process
 * daemon" until the server was restarted. The client now runs `revive` (the
 * server's ensureDaemon) before each attempt, with a doubling delay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ProcessManagerClient } from '../../src/process-daemon/process-manager-client.js';

let tmpDir: string;
let socketPath: string;
let server: net.Server | null;
let sockets: net.Socket[];
let client: ProcessManagerClient;

function startDaemon(): Promise<void> {
  server = net.createServer((socket) => { sockets.push(socket); });
  return new Promise((resolve) => server!.listen(socketPath, () => resolve()));
}

function stopDaemon(): Promise<void> {
  for (const socket of sockets) socket.destroy();
  sockets = [];
  const closing = server;
  server = null;
  return new Promise((resolve) => (closing ? closing.close(() => resolve()) : resolve()));
}

describe('ProcessManagerClient revives a daemon that stopped', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-pmc-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    sockets = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    client?.disconnect();
    await stopDaemon();
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts a new daemon and reconnects after the socket drops', async () => {
    await startDaemon();
    const revive = vi.fn(async () => { if (!server) await startDaemon(); });
    client = new ProcessManagerClient(socketPath, { revive });
    await client.connect();

    const disconnected = new Promise((resolve) => client.once('daemon-disconnected', resolve));
    const reconnected = new Promise((resolve) => client.once('daemon-reconnected', resolve));
    await stopDaemon();
    await disconnected;
    expect(client.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await reconnected;
    expect(revive).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(true);
  });

  it('doubles the delay while the daemon will not start', async () => {
    await startDaemon();
    const revive = vi.fn(async () => { throw new Error('daemon entry missing'); });
    client = new ProcessManagerClient(socketPath, { revive });
    await client.connect();
    await stopDaemon();
    await vi.waitFor(() => expect(client.isConnected()).toBe(false));

    await vi.advanceTimersByTimeAsync(2_000);
    expect(revive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_900);
    expect(revive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(revive).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(revive).toHaveBeenCalledTimes(3);
  });
});
