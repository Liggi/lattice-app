/**
 * Agents do not inherit the variables that configure the Lattice server, so a
 * dev server an agent starts cannot take Lattice's port.
 */

import { describe, expect, it } from 'vitest';
import { agentEnv } from '../../src/services/infrastructure/agent-env.js';

// The 3045 server's environment on 2026-09-29, as launched by `npx tsx src/server.ts`.
const SERVER_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/someone',
  GH_TOKEN: 'gho_x',
  PORT: '3045',
  HOST: '0.0.0.0',
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  NODE_PATH: '/repo/node_modules/.pnpm/node_modules',
  NODE_OPTIONS: '--inspect',
  CLAUDECODE: '1',
  npm_config_local_prefix: '/repo',
  npm_package_name: 'lattice-app',
  LATTICE_CONFIG_DIR: '/Users/someone/.lattice-restyle',
  LATTICE_DAEMON_SOCKET: '/Users/someone/.lattice-restyle/daemon.sock',
  LATTICE_PROCESS_ROLE: 'daemon',
  LATTICE_TOOLKIT_SRC: '/repo/packages/toolkit/src',
  CUI_DAEMON_SOCKET: '/tmp/cui.sock',
  LATTICE_CLI: '/Users/someone/.lattice-restyle/bin/lattice',
};

describe('agentEnv', () => {
  it('drops server configuration and keeps the rest', () => {
    expect(agentEnv(SERVER_ENV)).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/someone',
      GH_TOKEN: 'gho_x',
      LATTICE_CLI: '/Users/someone/.lattice-restyle/bin/lattice',
    });
  });

  it('does not change the environment it was given', () => {
    const env = { ...SERVER_ENV };
    agentEnv(env);
    expect(env).toEqual(SERVER_ENV);
  });
});
