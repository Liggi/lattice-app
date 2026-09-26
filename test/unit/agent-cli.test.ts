/**
 * The `lattice` command the server writes for its agents.
 *
 * A source install puts no `lattice` on PATH, so a newcomer's coordinator
 * could not dispatch a single worker (2026-09-23 install run). The server now
 * writes one into its config dir that reaches this server from any cwd.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderAgentCli, shellQuote, writeAgentCli } from '../../src/services/infrastructure/agent-cli.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent cli '));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('agent CLI', () => {
  it('runs the CLI on this Node with the server address and config dir, from any cwd', () => {
    const entry = path.join(tmpRoot, 'fake cli.mjs');
    fs.writeFileSync(entry, [
      'console.log(JSON.stringify({',
      '  args: process.argv.slice(2),',
      '  configDir: process.env.LATTICE_CONFIG_DIR,',
      '  host: process.env.LATTICE_SERVER_HOST,',
      '  port: process.env.LATTICE_SERVER_PORT,',
      '}));',
    ].join('\n'));
    const target = path.join(tmpRoot, 'bin', 'lattice');
    const configDir = path.join(tmpRoot, "sam's config");

    expect(writeAgentCli({ host: '0.0.0.0', port: 3071, configDir, execArgv: [], cliEntry: entry }, target)).toBe(true);

    const out = execFileSync(target, ['session', 'send', '--message', "it's done"], { cwd: os.homedir(), encoding: 'utf-8' });
    expect(JSON.parse(out)).toEqual({
      args: ['session', 'send', '--message', "it's done"],
      configDir,
      host: '127.0.0.1',
      port: '3071',
    });
  });

  it('points tsx at the repo tsconfig when running from source', () => {
    const script = renderAgentCli({ host: '127.0.0.1', port: 3001, cliEntry: '/repo/src/cli.ts', execArgv: [] });
    expect(script).toContain('export TSX_TSCONFIG_PATH=/repo/tsconfig.json');
  });

  it('leaves an operator-written wrapper alone', () => {
    const target = path.join(tmpRoot, 'lattice');
    fs.writeFileSync(target, '#!/bin/sh\nexec my-own-lattice "$@"\n');
    expect(writeAgentCli({ host: '127.0.0.1', port: 3001 }, target)).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toContain('my-own-lattice');
  });

  it('quotes only words the shell would split', () => {
    expect(shellQuote('/home/sam/.lattice/bin/lattice')).toBe('/home/sam/.lattice/bin/lattice');
    expect(shellQuote('/Users/Sam Smith/.lattice')).toBe("'/Users/Sam Smith/.lattice'");
  });
});
