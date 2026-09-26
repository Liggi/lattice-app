import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createSSEHandler } from '../../src/server/sse-handler.js'
import type { SessionManager } from '../../src/server/session-manager.js'

/**
 * Creates an in-process HTTP server for testing SSE.
 * Mounts the SSE handler at GET /session/:sessionId/events
 * and simple JSON endpoints for start/send/stop.
 */
export async function createTestServer(manager: SessionManager): Promise<{
  server: Server
  baseUrl: string
  close: () => Promise<void>
}> {
  const sseHandler = createSSEHandler(manager, { heartbeatMs: 500 })

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathParts = url.pathname.split('/').filter(Boolean)
    // Expected paths: session/:sessionId/events, session/:sessionId/start, etc.

    if (pathParts[0] !== 'session' || !pathParts[1]) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const sessionId = pathParts[1]
    const action = pathParts[2]

    if (req.method === 'GET' && action === 'events') {
      sseHandler(req, res, sessionId)
      return
    }

    // History endpoint — mirrors the Lattice /history route for testing
    // useSession's onConnected auto-fetch and fetchHistory behavior.
    if (req.method === 'GET' && action === 'history') {
      const log = manager.getLog(sessionId)
      if (!log) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ events: [], hasMore: false }))
        return
      }
      const before = Number(url.searchParams.get('before') ?? String(Number.MAX_SAFE_INTEGER))
      const limit = Number(url.searchParams.get('limit') ?? '50')

      const allEvents = [...log.all()]
      const filtered = allEvents.filter(e => e.seq < before)
      const hasMore = filtered.length > limit
      const sliced = filtered.slice(Math.max(0, filtered.length - limit))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ events: sliced, hasMore }))
      return
    }

    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', async () => {
        try {
          const data = body ? JSON.parse(body) : {}
          if (action === 'start') {
            const runId = await manager.start(sessionId, data)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ runId }))
          } else if (action === 'send') {
            const { input: sendInput, ...sendExtra } = data
            await manager.send(sessionId, sendInput, Object.keys(sendExtra).length > 0 ? sendExtra : undefined)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          } else if (action === 'stop') {
            await manager.stop(sessionId)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          } else {
            res.writeHead(404)
            res.end('Not found')
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: (err as Error).message }))
        }
      })
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const baseUrl = `http://127.0.0.1:${port}`
      resolve({
        server,
        baseUrl,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}
