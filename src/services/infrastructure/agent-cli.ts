/**
 * The `lattice` command the agents this server starts use to reach it.
 *
 * Coordinators and workers dispatch, report and read project state through
 * `lattice session …`. A source install puts nothing on PATH, and agents run
 * login shells that rebuild PATH anyway, so the preambles name this file by
 * absolute path instead. The server rewrites it on every start so it always
 * carries this server's Node binary (native modules are built for one ABI),
 * config dir and port.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG_DIR } from '@/utils/constants.js';

export const AGENT_CLI_PATH = path.join(CONFIG_DIR, 'bin', 'lattice');
const GENERATED_MARKER = '# Written by the Lattice server on every start. Edits are overwritten.';

/** Quote for POSIX sh unless the word is already safe bare. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export interface AgentCliTarget {
  host: string;
  port: number;
  configDir?: string;
  nodePath?: string;
  /** Node flags the CLI needs, e.g. tsx's loader when running from source. */
  execArgv?: string[];
  cliEntry?: string;
}

/** The CLI beside this module: compiled `cli.js` in a build, `cli.ts` under tsx. */
function resolveCliEntry(): string {
  const fromSource = import.meta.url.endsWith('.ts');
  return fileURLToPath(new URL(fromSource ? '../../cli.ts' : '../../cli.js', import.meta.url));
}

export function renderAgentCli(target: AgentCliTarget): string {
  const cliEntry = target.cliEntry ?? resolveCliEntry();
  const command = [target.nodePath ?? process.execPath, ...(target.execArgv ?? process.execArgv), cliEntry]
    .map(shellQuote)
    .join(' ');
  // 0.0.0.0 and :: are bind addresses, not dial addresses.
  const dialHost = target.host === '0.0.0.0' || target.host === '::' ? '127.0.0.1' : target.host;
  const lines = [
    '#!/bin/sh',
    GENERATED_MARKER,
    `export LATTICE_CONFIG_DIR=${shellQuote(target.configDir ?? CONFIG_DIR)}`,
    `export LATTICE_SERVER_HOST=${shellQuote(dialHost)}`,
    `export LATTICE_SERVER_PORT=${target.port}`,
  ];
  if (cliEntry.endsWith('.ts')) {
    // tsx looks for tsconfig.json from the cwd, which is the agent's project.
    lines.push(`export TSX_TSCONFIG_PATH=${shellQuote(path.resolve(path.dirname(cliEntry), '..', 'tsconfig.json'))}`);
  }
  lines.push(`exec ${command} "$@"`, '');
  return lines.join('\n');
}

/**
 * Write the command, unless a file this server did not generate is already
 * there: an operator's own wrapper wins. Returns whether it wrote.
 */
export function writeAgentCli(target: AgentCliTarget, filePath: string = AGENT_CLI_PATH): boolean {
  if (fs.existsSync(filePath) && !fs.readFileSync(filePath, 'utf-8').includes(GENERATED_MARKER)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, renderAgentCli(target), { mode: 0o755 });
  fs.renameSync(temp, filePath);
  return true;
}
