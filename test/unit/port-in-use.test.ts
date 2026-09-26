import net from 'net';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';
import { isPortServed } from '../../src/utils/port-in-use.js';

describe('isPortServed', () => {
  // On macOS a 127.0.0.1 bind succeeds while another process holds *:<port>,
  // so the probe has to see a wildcard listener from the loopback address.
  it('sees a wildcard listener from 127.0.0.1, and nothing once it closes', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '::', () => resolve()));
    const { port } = holder.address() as AddressInfo;

    expect(await isPortServed('127.0.0.1', port)).toBe(true);

    await new Promise<void>((resolve) => holder.close(() => resolve()));
    expect(await isPortServed('127.0.0.1', port)).toBe(false);
  });

  // The older npm release listens on `localhost`, which macOS resolves to ::1.
  it('sees an IPv6-only loopback listener from 127.0.0.1', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '::1', () => resolve()));
    const { port } = holder.address() as AddressInfo;

    expect(await isPortServed('127.0.0.1', port)).toBe(true);

    await new Promise<void>((resolve) => holder.close(() => resolve()));
  });
});
