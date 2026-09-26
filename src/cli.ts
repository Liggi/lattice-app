#!/usr/bin/env node
/**
 * `lattice` CLI bootstrap.
 *
 * This file's sole job is to set LATTICE_PROCESS_ROLE BEFORE any module
 * that eagerly initializes the logger singleton is loaded. ESM hoists
 * static imports, so any `import` written here would resolve before
 * imperative code can set the env var — which is why we use a dynamic
 * import below.
 *
 * Why this matters: the logger singleton (services/infrastructure/logger.ts)
 * is exported eagerly. When the CLI runs a `lattice session ...` subcommand
 * under a read-only sandbox (e.g. codex `--sandbox read-only`), the default
 * 'server' role tries to open a pino destination at ~/.lattice/logs/server.log
 * and crashes on exit with "sonic boom is not ready yet". Setting role='cli'
 * here makes the logger skip the file destination entirely.
 */

const firstArg = process.argv[2];
// `lattice --port N` is `lattice serve --port N`: any leading flag starts the server.
const isServerInvocation =
  !firstArg ||
  firstArg === 'serve' ||
  firstArg.startsWith('-') ||
  firstArg === 'help';

// Always override for CLI subcommand invocations — even if LATTICE_PROCESS_ROLE
// is already set in the environment. The Lattice daemon sets the env var to
// 'daemon' at startup (see process-daemon/index.ts:22), and that value leaks
// through every spawned subprocess: daemon → Claude CLI → user's nested codex/
// shell → `lattice session ...`. Without an unconditional override, the logger
// would try to open ~/.lattice/logs/daemon.jsonl for write — which fails with
// EPERM under codex's read-only sandbox and surfaces as "sonic boom is not
// ready yet" on process exit.
if (!isServerInvocation) {
  process.env.LATTICE_PROCESS_ROLE = 'cli';
}

const { run } = await import('./cli-main.js');

run().catch((error: unknown) => {
  if (error instanceof Error) {
    process.stderr.write(`lattice: ${error.message}\n`);
  } else {
    process.stderr.write(`lattice: ${String(error)}\n`);
  }
  process.exit(1);
});

// Mark this file as a module so top-level `await import(...)` is allowed.
export {};
