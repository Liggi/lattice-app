/**
 * `lattice` CLI main entrypoint. Imported lazily by ./cli.ts AFTER
 * LATTICE_PROCESS_ROLE has been set, so the logger singleton initializes
 * with the right role before any module-level `createLogger()` calls run.
 *
 * Don't add static `import` lines here that touch the eager logger from
 * a context where the role hasn't been set yet — the bootstrap in cli.ts
 * is what guarantees ordering.
 */
import { main as startServer } from './server.js';
import { runSessionCommand } from './cli/session-commands.js';
import { renderSessionUsageBlock } from './cli/session-cli-spec.js';
import { FEEDBACK_USAGE, runFeedbackCommand } from './cli/feedback-command.js';
import { ASK_USAGE, runAskCommand } from './cli/ask-command.js';
import { DIAGRAM_USAGE, runDiagramCommand } from './cli/diagram-command.js';

// The session block is generated from the verb spec rather than written out
// here. Hand-maintained, it went stale: it hid `list --project/--tag` and
// `inputs --from/--to` entirely, and showed flags in a form the parser did not
// accept. Generated, it cannot describe a flag the CLI does not have.
const HELP = `lattice-app — Lattice

Usage:
  lattice-app [serve] [--port N] [--host H]
      Start the HTTP server (default if no command).

Agents dispatch with the same program through <data folder>/bin/lattice,
which is what the session commands below are written for.

${renderSessionUsageBlock()}

${FEEDBACK_USAGE}
${ASK_USAGE}
${DIAGRAM_USAGE}
  lattice session <verb> --help        Flags and notes for one verb.
  lattice --help | -h                  Show this help.
`;

export async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const first = args[0];

  if (first === '-h' || first === '--help' || first === 'help') {
    process.stdout.write(HELP);
    return;
  }

  // Bare invocation, explicit serve, or server options with serve left out
  // (`lattice --port N`): rewrite argv so the existing parseArgs (in
  // server.ts) sees only the trailing options it knows about.
  if (!first || first === 'serve' || first.startsWith('-')) {
    process.argv = [process.argv[0], process.argv[1], ...args.slice(first === 'serve' ? 1 : 0)];
    await startServer();
    return;
  }

  if (first === 'session') {
    runSessionCommand(args.slice(1));
    return;
  }

  if (first === 'feedback') {
    await runFeedbackCommand(args.slice(1));
    return;
  }

  if (first === 'diagram') {
    await runDiagramCommand(args.slice(1));
    return;
  }

  if (first === 'ask') {
    await runAskCommand(args.slice(1));
    return;
  }

  process.stderr.write(`lattice-app: unknown command "${first}"\n\n`);
  process.stderr.write(HELP);
  process.exit(1);
}
