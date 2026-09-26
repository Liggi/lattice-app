import os from 'os';
import path from 'path';

/**
 * Expand shell-style home shorthands because Node spawn/process APIs do not.
 */
export function normalizeWorkingDirectory(workingDirectory?: string): string | undefined {
  if (!workingDirectory) {
    return workingDirectory;
  }

  if (workingDirectory === '~') {
    return os.homedir();
  }

  if (workingDirectory.startsWith('~/') || workingDirectory.startsWith('~\\')) {
    return path.join(os.homedir(), workingDirectory.slice(2));
  }

  return workingDirectory;
}
