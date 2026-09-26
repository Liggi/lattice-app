import { describe, it, expect } from 'vitest'
import { JsonLinesParser } from '../../src/server/json-lines-parser.js'

describe('JsonLinesParser', () => {
  it('parses a complete line', () => {
    const parser = new JsonLinesParser()
    const results = parser.feed('{"type":"system"}\n')
    expect(results).toEqual([{ type: 'system' }])
  })

  it('parses multiple lines in one chunk', () => {
    const parser = new JsonLinesParser()
    const results = parser.feed('{"a":1}\n{"b":2}\n')
    expect(results).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('buffers partial lines across chunks', () => {
    const parser = new JsonLinesParser()
    expect(parser.feed('{"type":')).toEqual([])
    expect(parser.feed('"system"}\n')).toEqual([{ type: 'system' }])
  })

  it('handles a line split across three chunks', () => {
    const parser = new JsonLinesParser()
    expect(parser.feed('{"a"')).toEqual([])
    expect(parser.feed(':1,')).toEqual([])
    expect(parser.feed('"b":2}\n')).toEqual([{ a: 1, b: 2 }])
  })

  it('skips empty lines', () => {
    const parser = new JsonLinesParser()
    const results = parser.feed('{"a":1}\n\n{"b":2}\n')
    expect(results).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('skips malformed JSON and continues', () => {
    const parser = new JsonLinesParser()
    const results = parser.feed('not json\n{"ok":true}\n')
    expect(results).toEqual([{ ok: true }])
  })

  it('strips ANSI escape sequences', () => {
    const parser = new JsonLinesParser()
    const results = parser.feed('\x1b[32m{"type":"test"}\x1b[0m\n')
    expect(results).toEqual([{ type: 'test' }])
  })

  it('handles ANSI in the middle of JSON', () => {
    const parser = new JsonLinesParser()
    const results = parser.feed('{"type":"\x1b[1mtest\x1b[0m"}\n')
    expect(results).toEqual([{ type: 'test' }])
  })

  it('flush() emits buffered partial line if valid JSON', () => {
    const parser = new JsonLinesParser()
    parser.feed('{"final":true}')
    expect(parser.flush()).toEqual([{ final: true }])
  })

  it('flush() returns empty for invalid buffer', () => {
    const parser = new JsonLinesParser()
    parser.feed('not json')
    expect(parser.flush()).toEqual([])
  })

  it('flush() returns empty for empty buffer', () => {
    const parser = new JsonLinesParser()
    expect(parser.flush()).toEqual([])
  })

  it('flush() clears the buffer', () => {
    const parser = new JsonLinesParser()
    parser.feed('{"a":1}')
    parser.flush()
    expect(parser.flush()).toEqual([])
  })

  it('handles real Claude CLI output sequence', () => {
    const parser = new JsonLinesParser()
    const init = '{"type":"system","subtype":"init","session_id":"abc"}\n'
    const assistant =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n'
    const result = '{"type":"result","duration_ms":1000}\n'

    const r1 = parser.feed(init)
    const r2 = parser.feed(assistant)
    const r3 = parser.feed(result)

    expect(r1).toHaveLength(1)
    expect(r1[0]).toHaveProperty('type', 'system')
    expect(r2).toHaveLength(1)
    expect(r2[0]).toHaveProperty('type', 'assistant')
    expect(r3).toHaveLength(1)
    expect(r3[0]).toHaveProperty('type', 'result')
  })
})
