/**
 * Only an instance holding a matching host-integration marker may write the
 * machine's shared Claude state.
 *
 * On 2026-09-21 a worker started a throwaway server with LATTICE_CONFIG_DIR
 * pointed at /tmp. That isolates the database and nothing else: the server
 * repointed ~/.claude/settings.json and ~/.claude/hooks/pre-compact-hook.sh at
 * its own port, every live claude worker opened a socket there to serve the
 * hooks, and the fixture's `lsof -ti:<port> | xargs kill` cleanup then killed
 * four unrelated workers along with the fixture.
 *
 * The marker names the config dir it was issued for. The copied-marker case
 * below is the one that matters: the fixture was made by copying a real config
 * dir, so a marker carrying only a boolean would have travelled with it and
 * granted the fixture exactly the authority this is meant to withhold.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHostIntegration } from '../../src/services/infrastructure/host-integration.js';

let tmpRoot: string;

function writeMarker(dir: string, marker: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'host-integration.json'), JSON.stringify(marker, null, 2));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-integration-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('host integration authority', () => {
  it('grants authority to a config dir whose marker names itself', () => {
    const configDir = path.join(tmpRoot, 'real');
    writeMarker(configDir, {
      manageClaudeSettings: true,
      configDir,
      daemonSocket: path.join(configDir, 'daemon.sock'),
    });

    const authority = resolveHostIntegration(configDir);

    expect(authority.manageClaudeSettings).toBe(true);
    expect(authority.deniedReason).toBeNull();
    expect(authority.daemonSocket).toBe(path.join(configDir, 'daemon.sock'));
  });

  it('withholds authority from a config dir copied from a granted one', () => {
    const real = path.join(tmpRoot, 'real');
    const fixture = path.join(tmpRoot, 'fixture');
    writeMarker(real, { manageClaudeSettings: true, configDir: real });

    // Exactly how the 2026-09-21 fixture was built: copy a real config dir,
    // change the port, launch. The marker comes along and still names `real`.
    fs.cpSync(real, fixture, { recursive: true });

    const authority = resolveHostIntegration(fixture);

    expect(authority.manageClaudeSettings).toBe(false);
    expect(authority.deniedReason).toContain('was issued for');
  });

  it('withholds authority when no marker is present', () => {
    const configDir = path.join(tmpRoot, 'bare');
    fs.mkdirSync(configDir, { recursive: true });

    const authority = resolveHostIntegration(configDir);

    expect(authority.manageClaudeSettings).toBe(false);
    expect(authority.deniedReason).toContain('no host-integration marker');
  });

  it('withholds authority when the marker does not opt in', () => {
    const configDir = path.join(tmpRoot, 'optout');
    writeMarker(configDir, { manageClaudeSettings: false, configDir });

    const authority = resolveHostIntegration(configDir);

    expect(authority.manageClaudeSettings).toBe(false);
    expect(authority.deniedReason).toContain('does not set manageClaudeSettings');
  });

  it('withholds authority when the marker is unreadable', () => {
    const configDir = path.join(tmpRoot, 'corrupt');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'host-integration.json'), '{ not json');

    const authority = resolveHostIntegration(configDir);

    expect(authority.manageClaudeSettings).toBe(false);
    expect(authority.deniedReason).toContain('unreadable');
  });

  it('resolves the declared dir before comparing, so equivalent paths still match', () => {
    const configDir = path.join(tmpRoot, 'real');
    writeMarker(configDir, {
      manageClaudeSettings: true,
      configDir: path.join(tmpRoot, 'real', '.'),
    });

    expect(resolveHostIntegration(configDir).manageClaudeSettings).toBe(true);
  });

  it('is decided by the marker alone, never by the environment', () => {
    const fixture = path.join(tmpRoot, 'fixture');
    fs.mkdirSync(fixture, { recursive: true });

    // The failed design was a boolean env var set by the real launcher. A
    // server passes its environment to its workers and a worker passes it to
    // any server it launches, so the flag arrives at precisely the process it
    // was meant to exclude. Nothing here reads the environment, so setting
    // every plausible variable changes nothing.
    const saved = { ...process.env };
    process.env.LATTICE_MANAGED_HOOKS = '1';
    process.env.LATTICE_CONFIG_DIR = path.join(tmpRoot, 'real');
    process.env.LATTICE_DAEMON_SOCKET = '/tmp/inherited.sock';
    try {
      expect(resolveHostIntegration(fixture).manageClaudeSettings).toBe(false);
    } finally {
      process.env = saved;
    }
  });
});

// Left on disk deliberately. Importing ensure-daemon initialises the logger,
// which creates <configDir>/logs asynchronously and outlives the test; removing
// the dir races that write and surfaces as an unhandled ENOENT. These are
// mkdtemp dirs under the system temp root, so the OS reclaims them.
const daemonFixtures: string[] = [];

describe('daemon socket isolation', () => {
  it('ignores an inherited socket variable the marker does not claim', async () => {
    // Its own root, cleaned at the end of the file: importing ensure-daemon
    // pulls in the logger, which creates <configDir>/logs asynchronously and
    // would race the per-test cleanup.
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'host-integration-daemon-'));
    daemonFixtures.push(fixture);
    fs.mkdirSync(path.join(fixture, 'logs'), { recursive: true });

    const saved = { ...process.env };
    process.env.LATTICE_CONFIG_DIR = fixture;
    process.env.LATTICE_DAEMON_SOCKET = '/Users/dev/.lattice-alt/daemon.sock';
    try {
      // Fresh module graph: CONFIG_DIR and the cached authority are both
      // resolved at import time from the environment set above.
      vi.resetModules();
      const { resolveSocketPath } = await import('../../src/process-daemon/ensure-daemon.js');
      expect(resolveSocketPath()).toBe(path.join(fixture, 'daemon.sock'));
    } finally {
      process.env = saved;
    }
  });
  it('rejects an override that matches a socket declared by an invalid marker', async () => {
    // The nastiest copied-fixture case: the marker travelled with the copy, so
    // it names the original root AND declares the original socket, and the
    // inherited environment carries that exact socket string. Every value
    // agrees with every other value; only the root binding disagrees, and that
    // is what has to decide it.
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'host-integration-real-'));
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'host-integration-copy-'));
    daemonFixtures.push(real, fixture);
    const realSocket = path.join(real, 'daemon.sock');
    writeMarker(real, { manageClaudeSettings: true, configDir: real, daemonSocket: realSocket });
    fs.cpSync(real, fixture, { recursive: true });
    fs.mkdirSync(path.join(fixture, 'logs'), { recursive: true });

    expect(resolveHostIntegration(fixture).manageClaudeSettings).toBe(false);
    expect(resolveHostIntegration(fixture).daemonSocket).toBeNull();

    const saved = { ...process.env };
    process.env.LATTICE_CONFIG_DIR = fixture;
    process.env.LATTICE_DAEMON_SOCKET = realSocket;
    try {
      vi.resetModules();
      const { decideSocketPath } = await import('../../src/process-daemon/resolve-socket-path.js');
      const decision = decideSocketPath();
      expect(decision.socketPath).toBe(path.join(fixture, 'daemon.sock'));
      expect(decision.unboundOverride).toBe(realSocket);
    } finally {
      process.env = saved;
    }
  });

  it('honours an override the acting config dir\'s own marker claims', async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'host-integration-bound-'));
    daemonFixtures.push(real);
    const socket = path.join(real, 'daemon.sock');
    writeMarker(real, { manageClaudeSettings: true, configDir: real, daemonSocket: socket });
    fs.mkdirSync(path.join(real, 'logs'), { recursive: true });

    const saved = { ...process.env };
    process.env.LATTICE_CONFIG_DIR = real;
    process.env.LATTICE_DAEMON_SOCKET = socket;
    try {
      vi.resetModules();
      const { decideSocketPath } = await import('../../src/process-daemon/resolve-socket-path.js');
      const decision = decideSocketPath();
      expect(decision.socketPath).toBe(socket);
      expect(decision.unboundOverride).toBeNull();
    } finally {
      process.env = saved;
    }
  });

  it('matches a config dir reached through a symlink', () => {
    // path.resolve is lexical. A config dir reached through a link would fail a
    // textual comparison against a marker naming the real path, withholding
    // authority from a legitimate instance.
    const real = path.join(tmpRoot, 'real-root');
    const link = path.join(tmpRoot, 'link-root');
    writeMarker(real, { manageClaudeSettings: true, configDir: real });
    fs.symlinkSync(real, link);

    expect(resolveHostIntegration(link).manageClaudeSettings).toBe(true);
  });
  it('uses the marker\'s socket when no override is set at all', async () => {
    // The earlier version returned the shared default whenever the environment
    // was empty, so a fixture launched from a clean shell attached to the
    // production daemon anyway. The marker decides, not the environment.
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'host-integration-noenv-'));
    daemonFixtures.push(real);
    const socket = path.join(real, 'custom-daemon.sock');
    writeMarker(real, { manageClaudeSettings: true, configDir: real, daemonSocket: socket });
    fs.mkdirSync(path.join(real, 'logs'), { recursive: true });

    const saved = { ...process.env };
    process.env.LATTICE_CONFIG_DIR = real;
    delete process.env.LATTICE_DAEMON_SOCKET;
    delete process.env.CUI_DAEMON_SOCKET;
    try {
      vi.resetModules();
      const { decideSocketPath } = await import('../../src/process-daemon/resolve-socket-path.js');
      expect(decideSocketPath().socketPath).toBe(socket);
    } finally {
      process.env = saved;
    }
  });

  it('gives an unmarked config dir its own socket, never the shared default', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'host-integration-nomarker-'));
    daemonFixtures.push(fixture);
    fs.mkdirSync(path.join(fixture, 'logs'), { recursive: true });

    const saved = { ...process.env };
    process.env.LATTICE_CONFIG_DIR = fixture;
    delete process.env.LATTICE_DAEMON_SOCKET;
    delete process.env.CUI_DAEMON_SOCKET;
    try {
      vi.resetModules();
      const { DEFAULT_SOCKET_PATH } = await import('../../src/process-daemon/types.js');
      const { decideSocketPath } = await import('../../src/process-daemon/resolve-socket-path.js');
      const decision = decideSocketPath();
      expect(decision.socketPath).toBe(path.join(fixture, 'daemon.sock'));
      expect(decision.socketPath).not.toBe(DEFAULT_SOCKET_PATH);
    } finally {
      process.env = saved;
    }
  });

  it('reports a CUI_DAEMON_SOCKET alias that conflicts with the marker', async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'host-integration-alias-'));
    daemonFixtures.push(real);
    const socket = path.join(real, 'daemon.sock');
    writeMarker(real, { manageClaudeSettings: true, configDir: real, daemonSocket: socket });
    fs.mkdirSync(path.join(real, 'logs'), { recursive: true });

    const saved = { ...process.env };
    process.env.LATTICE_CONFIG_DIR = real;
    delete process.env.LATTICE_DAEMON_SOCKET;
    process.env.CUI_DAEMON_SOCKET = '/tmp/some-other-daemon.sock';
    try {
      vi.resetModules();
      const { decideSocketPath } = await import('../../src/process-daemon/resolve-socket-path.js');
      const decision = decideSocketPath();
      expect(decision.socketPath).toBe(socket);
      expect(decision.unboundOverride).toBe('/tmp/some-other-daemon.sock');
    } finally {
      process.env = saved;
    }
  });

  it('withholds authority from a marker declaring a relative root', () => {
    const configDir = path.join(tmpRoot, 'relative');
    writeMarker(configDir, { manageClaudeSettings: true, configDir: './relative' });

    const authority = resolveHostIntegration(configDir);

    expect(authority.manageClaudeSettings).toBe(false);
    expect(authority.deniedReason).toContain('relative configDir');
  });
  it('withholds authority when the declared root cannot be resolved', () => {
    // A dangling symlink is the case that matters: lexically it resolves to a
    // path that compares equal, so the old fallback would have granted
    // authority on a root that does not exist.
    const configDir = path.join(tmpRoot, 'dangling');
    fs.mkdirSync(configDir, { recursive: true });
    const declared = path.join(tmpRoot, 'points-nowhere');
    fs.symlinkSync(path.join(tmpRoot, 'absent-target'), declared);
    writeMarker(configDir, { manageClaudeSettings: true, configDir: declared });

    const authority = resolveHostIntegration(configDir);

    expect(authority.manageClaudeSettings).toBe(false);
    expect(authority.deniedReason).toContain('cannot establish identity');
    expect(authority.daemonSocket).toBeNull();
  });

  it('withholds authority when the acting config dir cannot be resolved', () => {
    // The other arm of the same rule. Reaching it needs the dir to disappear
    // between the marker read and the identity check, so the spy stands in for
    // that race rather than trying to lose it. The marker declares the dir
    // through a symlink, so the declared side still resolves and the acting
    // side is the one that fails: lexically the two compare equal, which is
    // exactly what the removed fallback would have granted on.
    const configDir = path.join(tmpRoot, 'vanishing');
    const alias = path.join(tmpRoot, 'vanishing-alias');
    fs.mkdirSync(configDir, { recursive: true });
    fs.symlinkSync(configDir, alias);
    writeMarker(configDir, {
      manageClaudeSettings: true,
      configDir: alias,
      daemonSocket: path.join(configDir, 'daemon.sock'),
    });

    const real = fs.realpathSync;
    const spy = vi.spyOn(fs, 'realpathSync').mockImplementation(((target: fs.PathLike) => {
      if (String(target) === path.resolve(configDir)) {
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, realpath '${String(target)}'`),
          { code: 'ENOENT' }
        );
      }
      return real(target as string);
    }) as typeof fs.realpathSync);

    try {
      const authority = resolveHostIntegration(configDir);

      expect(authority.manageClaudeSettings).toBe(false);
      expect(authority.deniedReason).toContain('acting config dir');
      expect(authority.daemonSocket).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('withholds authority when the declared root no longer exists', () => {
    const configDir = path.join(tmpRoot, 'deleted-root');
    fs.mkdirSync(configDir, { recursive: true });
    writeMarker(configDir, {
      manageClaudeSettings: true,
      configDir: path.join(tmpRoot, 'never-created'),
      daemonSocket: path.join(tmpRoot, 'never-created', 'daemon.sock'),
    });

    const authority = resolveHostIntegration(configDir);

    expect(authority.manageClaudeSettings).toBe(false);
    expect(authority.daemonSocket).toBeNull();
  });
});
