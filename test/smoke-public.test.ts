import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { runPublicSmoke } from '../scripts/smoke-public.mts'

const manifest = JSON.stringify({
  schemaVersion: 1,
  current: 'v1',
  previous: null,
  updatedAt: '2026-09-03T00:00:00.000Z',
  versions: {
    v1: {
      prefix: 'versions/v1',
      publishedAt: '2026-09-03T00:00:00.000Z',
    },
  },
})
const payload = '{"synthetic":true}\n'

test('public smoke checks path-only manifest, fixed GET, and one-byte Range contract', async () => {
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(request.url ?? '')
    if (request.url === '/manifest.json') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': manifest.length,
        'Cache-Control': 'public, max-age=60, must-revalidate',
      })
      response.end(manifest)
      return
    }
    if (request.url === '/versions/v1/api/ja.json' && request.headers.range === 'bytes=0-0') {
      response.writeHead(206, {
        'Content-Type': 'application/json',
        'Content-Length': '1',
        'Content-Range': `bytes 0-0/${payload.length}`,
        ETag: '"synthetic-etag"',
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      response.end('x')
      return
    }
    if (request.url === '/versions/v1/api/ja.json') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
        ETag: '"synthetic-etag"',
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      response.end(payload)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const result = await runPublicSmoke(`http://127.0.0.1:${address.port}`, 'v1')
    assert.deepEqual(result, { version: 'v1', fixedPath: '/versions/v1/api/ja.json' })
    assert.deepEqual(paths, [
      '/manifest.json',
      '/versions/v1/api/ja.json',
      '/versions/v1/api/ja.json',
    ])
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('public smoke rejects a stale manifest current version', async () => {
  const fetchImpl = async () =>
    new Response(manifest, {
      status: 200,
      headers: { 'Cache-Control': 'no-cache' },
    })
  await assert.rejects(
    runPublicSmoke('https://data.example.invalid', 'v2', fetchImpl),
    /does not match expected/,
  )
})

test('public smoke requires an origin-only base URL', async () => {
  await assert.rejects(
    runPublicSmoke('https://data.example.invalid/distribution'),
    /base URL must not contain/,
  )
})
