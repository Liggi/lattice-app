/**
 * Reading a job's count from its work (2026-10-11, thread 38265; see
 * `job-progress.ts`). Three kinds of source covered 22 of the 25 real jobs
 * Running had shown:
 *
 * - files appearing in a folder (`--files 'data/final/*.json'`): one
 *   directory read, matching the last part of the path;
 * - lines in a file, optionally only those matching a pattern (`--lines
 *   batch.log --match 'batch repair'`): only the bytes added since the last
 *   read are read, so a long log costs nothing to follow;
 * - a number a command prints (`--command 'bin/ck3 rig year'`), for counts
 *   that live on another machine or inside a file that must be parsed: run in
 *   its own time, at most for ten seconds.
 *
 * Every failure is an error whose message says what went wrong in full; the
 * panel shows it as written.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { JobSource } from './job-progress.js';

/** How long a count command may run. */
export const COMMAND_TIMEOUT_MS = 10_000;
/** How often a count command runs when the agent did not say. */
export const COMMAND_EVERY_MS = 2 * 60_000;
const CHUNK = 1 << 20;

export class CountError extends Error {}

/** Where a line count got to in its file, so the next read starts there. */
interface LinePlace {
  offset: number;
  count: number;
  /** The end of the file after the last newline: a line still being written. */
  partial: string;
}

/**
 * Counts for running jobs. One per server: it remembers where each line
 * count got to, keyed by the job, so each read takes only the new bytes.
 */
export class JobCounter {
  private readonly places = new Map<string, LinePlace>();

  async count(key: string, source: JobSource): Promise<number> {
    if (source.kind === 'files') return countFiles(source.glob);
    if (source.kind === 'lines') return this.countLines(key, source.file, source.match);
    return runCountCommand(source.command, source.cwd);
  }

  /** Forget a job that has ended. */
  forget(key: string): void {
    this.places.delete(key);
  }

  private countLines(key: string, file: string, match: string | undefined): number {
    const pattern = match === undefined ? null : new RegExp(match);
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch (error) {
      throw new CountError(describeFsError(error, file));
    }
    try {
      const size = fs.fstatSync(fd).size;
      let place = this.places.get(key);
      // A file that got shorter was replaced or truncated: count it again from the top.
      if (!place || size < place.offset) place = { offset: 0, count: 0, partial: '' };
      const buffer = Buffer.alloc(CHUNK);
      while (place.offset < size) {
        const read = fs.readSync(fd, buffer, 0, Math.min(CHUNK, size - place.offset), place.offset);
        if (read <= 0) break;
        place.offset += read;
        const text = place.partial + buffer.toString('utf-8', 0, read);
        const lines = text.split('\n');
        place.partial = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() === '') continue;
          if (!pattern || pattern.test(line)) place.count += 1;
        }
      }
      this.places.set(key, place);
      return place.count;
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** The files matching a path whose last part may hold a pattern (`*`, `?`, `[ab]`, `{a,b}`). */
export function countFiles(glob: string): number {
  const dir = path.dirname(glob);
  const pattern = path.basename(glob);
  if (/[*?[\]{}]/.test(dir)) {
    throw new CountError(`Only the last part of the path can have a pattern in it (${glob}); point --files at one folder, such as 'out/batch/*.json'.`);
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new CountError(describeFsError(error, dir));
  }
  return entries.filter((entry) => !entry.isDirectory() && minimatch(entry.name, pattern)).length;
}

/** The lines with something on them in a file, read whole: a measured total. */
export function countAllLines(file: string): number {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    throw new CountError(describeFsError(error, file));
  }
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

/** Run a count command in `cwd` and read the number on the last line it prints. */
export function runCountCommand(command: string, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) {
        const said = String(stderr).trim();
        const why = error.killed
          ? `the command took longer than ${COMMAND_TIMEOUT_MS / 1000} seconds and was stopped`
          : typeof error.code === 'number' ? `the command exited with code ${error.code}` : `the command could not run: ${error.message}`;
        reject(new CountError(said ? `${why}: ${said}` : why));
        return;
      }
      const last = String(stdout).trim().split('\n').at(-1)?.trim() ?? '';
      const number = last.match(/^(\d[\d,]*)$/);
      if (!number) {
        reject(new CountError(last ? `the command printed "${last}" as its last line, not a whole number` : 'the command printed nothing'));
        return;
      }
      resolve(Number(number[1].replace(/,/g, '')));
    });
  });
}

function describeFsError(error: unknown, target: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return `${target} does not exist`;
  if (code === 'EACCES' || code === 'EPERM') return `Lattice is not allowed to read ${target}`;
  if (code === 'ENOTDIR') return `${target} is not a folder`;
  if (code === 'EISDIR') return `${target} is a folder, not a file`;
  return `${target}: ${error instanceof Error ? error.message : String(error)}`;
}

/** Whether a process is running, by its pid. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The source in a few words, as `lattice job start` prints it. */
export function describeSource(source: JobSource): string {
  if (source.kind === 'files') return `files matching ${source.glob}`;
  if (source.kind === 'lines') return source.match === undefined ? `lines in ${source.file}` : `lines matching /${source.match}/ in ${source.file}`;
  return `the number \`${source.command}\` prints (run in ${source.cwd})`;
}
