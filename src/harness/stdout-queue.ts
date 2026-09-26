/**
 * Backing queue for adapters that synthesise a CLI stdout stream.
 *
 * Providers reached over an API (Codex's app-server, opencode's HTTP server)
 * have no real stdout, but `ProcessHandle.stdout` is an `AsyncIterable<string>`
 * of Claude-CLI-shaped JSONL. These adapters push translated lines in and the
 * harness consumes them as if a CLI had written them.
 */
export interface StdoutQueue extends AsyncIterable<string> {
  push: (line: string) => void;
  terminate: () => void;
}

export function createStdoutQueue(): StdoutQueue {
  const queue: string[] = [];
  let waiter: (() => void) | null = null;
  let terminated = false;

  const wake = (): void => {
    if (!waiter) return;
    const w = waiter;
    waiter = null;
    w();
  };

  return {
    push(line: string) {
      if (terminated) return;
      queue.push(line);
      wake();
    },
    terminate() {
      if (terminated) return;
      terminated = true;
      wake();
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          while (queue.length === 0 && !terminated) {
            await new Promise<void>((resolve) => {
              waiter = resolve;
            });
          }
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false };
          }
          return { value: undefined as unknown as string, done: true };
        },
      };
    },
  };
}
