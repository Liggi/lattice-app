import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const loopback = { ip: '127.0.0.1' } as Request;

async function loadAccessControl(runsFromSource: boolean) {
  vi.resetModules();
  vi.doMock('@/server/vite-dev-client.js', () => ({ runsFromSource, servesViteDevClient: false }));
  return import('@/diagnostics/access-control.js');
}

describe('diagnostics access control', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.doUnmock('@/server/vite-dev-client.js');
  });

  it('opens diagnostics to loopback for a source checkout in development', async () => {
    process.env.NODE_ENV = 'development';
    const access = await loadAccessControl(true);
    expect(access.mayReadDiagnostics(loopback)).toBe(true);
    expect(access.mayReadRawDiagnostics(loopback)).toBe(true);
    expect(access.describeAccessMode(loopback)).toBe('development-loopback');
  });

  it.each(['development', 'test'])(
    'keeps diagnostics closed on a built or installed server with NODE_ENV=%s',
    async (env) => {
      process.env.NODE_ENV = env;
      const access = await loadAccessControl(false);
      expect(access.mayReadDiagnostics(loopback)).toBe(false);
      expect(access.mayReadRawDiagnostics(loopback)).toBe(false);
      expect(access.describeAccessMode(loopback)).toBe('admin');
    },
  );
});
