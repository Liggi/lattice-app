/**
 * `lattice progress` used to take a count typed in by the agent. Lattice now
 * counts a job from its work (`lattice job start`, thread 38265), so this
 * only says where to go instead.
 */

import { PROGRESS_GONE } from '../services/sessions/job-progress.js';

export function runProgressCommand(): void {
  process.stderr.write(`${PROGRESS_GONE}\n`);
  process.exit(1);
}
