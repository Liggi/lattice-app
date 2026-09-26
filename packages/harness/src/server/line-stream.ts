/**
 * Turns a readable byte stream into an `AsyncIterable<string>` that yields
 * exactly one complete line per iteration.
 *
 * Adapters hand `ProcessHandle.stdout` to the harness, which feeds each
 * yielded value to a JSON-lines parser as a whole line. The CLI emits
 * newline-delimited JSON, but a single stdout read is capped (~64KB), so a
 * large object — a base64 image `tool_result` can be ~210KB — spans several
 * reads. Yielding raw `data` chunks splits that object across iterations, the
 * parse fails, and the event is silently dropped. `readline` reassembles
 * content across reads, emits one line at a time, and flushes a trailing
 * unterminated line when the stream closes.
 */

import { createInterface } from 'node:readline'

export function lineStream(readable: NodeJS.ReadableStream): AsyncIterable<string> {
  const queue: string[] = []
  let pending: ((result: IteratorResult<string>) => void) | null = null
  let closed = false

  const rl = createInterface({ input: readable })

  rl.on('line', (line: string) => {
    if (pending) {
      const resolve = pending
      pending = null
      resolve({ value: line, done: false })
    } else {
      queue.push(line)
    }
  })

  rl.on('close', () => {
    closed = true
    if (pending) {
      const resolve = pending
      pending = null
      resolve({ value: undefined as unknown as string, done: true })
    }
  })

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false })
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as string, done: true })
          }
          return new Promise((resolve) => {
            pending = resolve
          })
        },
      }
    },
  }
}
