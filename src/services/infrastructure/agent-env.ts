/**
 * The environment an agent process gets: the server's, minus what configures
 * the server itself.
 *
 * Every program an agent runs inherits this. On 2026-09-29 the launch line's
 * PORT=3045 reached a Claude worker, whose `next dev` bound Lattice's own port;
 * on 2026-09-21 an inherited LATTICE_CONFIG_DIR and LATTICE_DAEMON_SOCKET
 * attached a worker's test server to the live daemon (resolve-socket-path.ts).
 *
 * Removed:
 * - PORT, HOST: Lattice never reads them (its port comes from config.json or
 *   --port), but Next, Vite, Express and most dev servers bind to them.
 * - NODE_ENV, LOG_LEVEL: the server's run mode and log level. Next refuses to
 *   build and Jest skips its own 'test' default under an inherited NODE_ENV.
 * - NODE_PATH, npm_*: set by npx/pnpm when they start the server; they point
 *   module resolution and npm/pnpm config at the Lattice checkout.
 * - NODE_OPTIONS, VSCODE_INSPECTOR_OPTIONS: debugger/loader flags for the
 *   server's own Node.
 * - CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: make the Claude CLI think it is
 *   nested inside another Claude.
 * - LATTICE_*, CUI_* except LATTICE_CLI: server config. The `lattice` command
 *   agents use carries its own config dir, host and port (agent-cli.ts).
 */
const STRIPPED = new Set([
  'PORT',
  'HOST',
  'NODE_ENV',
  'LOG_LEVEL',
  'NODE_PATH',
  'NODE_OPTIONS',
  'VSCODE_INSPECTOR_OPTIONS',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
]);
const KEPT = new Set(['LATTICE_CLI']);

function isServerOnly(name: string): boolean {
  if (KEPT.has(name)) return false;
  return STRIPPED.has(name) || /^(npm_|LATTICE_|CUI_)/.test(name);
}

export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isServerOnly(name)));
}
