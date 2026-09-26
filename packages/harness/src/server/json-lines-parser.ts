/**
 * Stateful JSON lines parser. Buffers partial lines, emits complete JSON objects.
 * Strips ANSI escape sequences before parsing.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

export class JsonLinesParser {
  private buffer = ''

  /**
   * Feed a chunk of data. Returns all complete JSON objects parsed from it.
   * Partial lines are buffered for the next call.
   */
  feed(chunk: string): unknown[] {
    this.buffer += chunk
    const results: unknown[] = []
    const lines = this.buffer.split('\n')

    // Last element is either empty (line ended with \n) or a partial line
    this.buffer = lines.pop()!

    for (const line of lines) {
      const cleaned = line.replace(ANSI_RE, '').trim()
      if (cleaned === '') continue
      try {
        results.push(JSON.parse(cleaned))
      } catch {
        // Malformed JSON — skip this line silently
        // In production, the SessionManager logger would capture this
      }
    }

    return results
  }

  /**
   * Flush any remaining buffered content. Call when the stream ends.
   */
  flush(): unknown[] {
    if (this.buffer.trim() === '') {
      this.buffer = ''
      return []
    }
    const cleaned = this.buffer.replace(ANSI_RE, '').trim()
    this.buffer = ''
    if (cleaned === '') return []
    try {
      return [JSON.parse(cleaned)]
    } catch {
      return []
    }
  }
}
