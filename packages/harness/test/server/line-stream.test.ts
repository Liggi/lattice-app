import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { lineStream } from '../../src/server/line-stream.js'

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const line of iterable) out.push(line)
  return out
}

describe('lineStream', () => {
  it('yields one complete line per iteration', async () => {
    const source = new PassThrough()
    const lines = collect(lineStream(source))
    source.end('a\nb\nc\n')
    expect(await lines).toEqual(['a', 'b', 'c'])
  })

  it('flushes a trailing line that has no newline', async () => {
    const source = new PassThrough()
    const lines = collect(lineStream(source))
    source.end('first\nno-trailing-newline')
    expect(await lines).toEqual(['first', 'no-trailing-newline'])
  })

  it('reassembles a line that spans many reads', async () => {
    // The reason this helper exists: a base64 image tool_result can be ~210KB,
    // well past the ~64KB a single stdout read returns, so the JSON object
    // arrives in pieces. A raw-chunk iterator would emit those pieces as
    // separate values and the JSON parse would fail on every one of them.
    const payload = JSON.stringify({ type: 'user', data: 'x'.repeat(210_000) })
    const source = new PassThrough()
    const lines = collect(lineStream(source))

    for (let i = 0; i < payload.length; i += 60_000) {
      source.write(payload.slice(i, i + 60_000))
    }
    source.end('\n')

    const result = await lines
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(payload)
    expect(JSON.parse(result[0]).data).toHaveLength(210_000)
  })

  it('does not split on a newline inside a JSON string escape', async () => {
    const payload = JSON.stringify({ text: 'line one\nline two' })
    const source = new PassThrough()
    const lines = collect(lineStream(source))
    source.end(payload + '\n')
    expect(await lines).toEqual([payload])
  })

  it('buffers lines produced before anyone iterates', async () => {
    const source = new PassThrough()
    const stream = lineStream(source)
    source.write('early\n')
    await new Promise((resolve) => setTimeout(resolve, 10))
    source.end('late\n')
    expect(await collect(stream)).toEqual(['early', 'late'])
  })

  it('completes on an empty stream', async () => {
    const source = new PassThrough()
    const lines = collect(lineStream(source))
    source.end()
    expect(await lines).toEqual([])
  })
})
