/**
 * SSE parser vendored from @microsoft/fetch-event-source.
 * ~160 lines, zero-copy, WHATWG-compliant.
 *
 * Original: https://github.com/Azure/fetch-event-source
 * License: MIT
 *
 * Three-layer pipeline:
 *   getBytes(stream) → getLines(onLine) → getMessages(onId, onRetry, onMessage)
 */

export interface EventSourceMessage {
  id: string
  event: string
  data: string
  retry?: number
}

/**
 * Converts a ReadableStream into a callback pattern.
 */
export async function getBytes(
  stream: ReadableStream<Uint8Array>,
  onChunk: (arr: Uint8Array) => void,
): Promise<void> {
  const reader = stream.getReader()
  while (true) {
    const result = await reader.read()
    if (result.done) break
    onChunk(result.value)
  }
}

const enum ControlChars {
  NewLine = 10,
  CarriageReturn = 13,
  Space = 32,
  Colon = 58,
}

/**
 * Parses arbitrary byte chunks into EventSource line buffers.
 */
export function getLines(
  onLine: (line: Uint8Array, fieldLength: number) => void,
): (arr: Uint8Array) => void {
  let buffer: Uint8Array | undefined
  let position: number
  let fieldLength: number
  let discardTrailingNewline = false

  return function onChunk(arr: Uint8Array) {
    if (buffer === undefined) {
      buffer = arr
      position = 0
      fieldLength = -1
    } else {
      buffer = concat(buffer, arr)
    }

    const bufLength = buffer.length
    let lineStart = 0

    while (position < bufLength) {
      if (discardTrailingNewline) {
        if (buffer[position] === ControlChars.NewLine) {
          lineStart = ++position
        }
        discardTrailingNewline = false
      }

      let lineEnd = -1
      for (; position < bufLength && lineEnd === -1; ++position) {
        switch (buffer[position]) {
          case ControlChars.Colon:
            if (fieldLength === -1) {
              fieldLength = position - lineStart
            }
            break
          case ControlChars.CarriageReturn:
            discardTrailingNewline = true
          // falls through
          case ControlChars.NewLine:
            lineEnd = position
            break
        }
      }

      if (lineEnd === -1) {
        break
      }

      onLine(buffer.subarray(lineStart, lineEnd), fieldLength)
      lineStart = position
      fieldLength = -1
    }

    if (lineStart === bufLength) {
      buffer = undefined
    } else if (lineStart !== 0) {
      buffer = buffer.subarray(lineStart)
      position -= lineStart
    }
  }
}

/**
 * Parses line buffers into EventSourceMessages.
 */
export function getMessages(
  onId: (id: string) => void,
  onRetry: (retry: number) => void,
  onMessage?: (msg: EventSourceMessage) => void,
): (line: Uint8Array, fieldLength: number) => void {
  let message = newMessage()
  const decoder = new TextDecoder()

  return function onLine(line: Uint8Array, fieldLength: number) {
    if (line.length === 0) {
      onMessage?.(message)
      message = newMessage()
    } else if (fieldLength > 0) {
      const field = decoder.decode(line.subarray(0, fieldLength))
      const valueOffset =
        fieldLength + (line[fieldLength + 1] === ControlChars.Space ? 2 : 1)
      const value = decoder.decode(line.subarray(valueOffset))

      switch (field) {
        case 'data':
          message.data = message.data ? message.data + '\n' + value : value
          break
        case 'event':
          message.event = value
          break
        case 'id':
          onId((message.id = value))
          break
        case 'retry': {
          const retry = parseInt(value, 10)
          if (!isNaN(retry)) {
            onRetry((message.retry = retry))
          }
          break
        }
      }
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const res = new Uint8Array(a.length + b.length)
  res.set(a)
  res.set(b, a.length)
  return res
}

function newMessage(): EventSourceMessage {
  return {
    data: '',
    event: '',
    id: '',
    retry: undefined,
  }
}
