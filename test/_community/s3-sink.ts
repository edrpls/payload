/**
 * In-process S3 endpoint stand-in for the shared-context upload reproduction.
 *
 * The bug is observable purely at the transport layer — whether the adapter
 * ISSUES a PutObject for each created document — so no real bucket is needed:
 * PutObject is satisfied by a 200 with an ETag header. The server starts with
 * top-level await so config.ts can embed the port, and the recorded requests
 * are shared with int.spec.ts through the ESM module cache (same process
 * under vitest). `unref()` keeps config-only loads (type generation, etc.)
 * from hanging on the open handle.
 */
import http from 'node:http'

/** Decoded pathname of every PUT the sink received, in arrival order. */
export const putRequests: string[] = []

const server = http.createServer((req, res) => {
  if (req.method === 'PUT') {
    putRequests.push(decodeURIComponent(new URL(req.url ?? '/', 'http://sink').pathname))
  }
  req.on('data', () => {})
  req.on('end', () => {
    res.setHeader('ETag', '"s3-sink"')
    res.end()
  })
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
server.unref()

const address = server.address()
export const sinkPort = typeof address === 'object' && address !== null ? address.port : 0

export const closeSink = (): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()))
