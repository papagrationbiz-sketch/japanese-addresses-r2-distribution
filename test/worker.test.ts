import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../src/index'

const manifest = {
  schemaVersion: 1,
  current: 'v2',
  previous: 'v1',
  updatedAt: '2026-09-02T00:00:00.000Z',
  versions: {
    v1: {
      prefix: 'versions/v1',
      publishedAt: '2026-08-01T00:00:00.000Z',
    },
    v2: {
      prefix: 'versions/v2',
      publishedAt: '2026-09-01T00:00:00.000Z',
    },
  },
} as const

function fakeBucket(manifestValue: unknown = manifest) {
  const calls: string[] = []
  const bucket = {
    async get(key: string, options?: unknown) {
      calls.push(key)
      if (key === 'manifest.json') {
        if (manifestValue === null) return null
        return { json: async () => manifestValue }
      }

      const range = (options as { range?: { offset: number; length: number } } | undefined)?.range
      const offset = range?.offset ?? 0
      const length = range?.length ?? 10
      const body = new Uint8Array(Array.from({ length }, (_, index) => offset + index))
      return {
        body: new Response(body).body,
        size: 100,
        range: { offset, length },
        httpEtag: '"worker-etag"',
        writeHttpMetadata(headers: Headers) {
          headers.set('Content-Type', 'application/octet-stream')
        },
      }
    },
  }
  return { bucket: bucket as never, calls }
}

function context(): ExecutionContext {
  return { waitUntil() {} } as never
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://data.example${path}`, init)
}

test('rejects invalid and multi-range headers without reading the data object', async () => {
  const state = fakeBucket()
  const response = await worker.fetch(
    request('/api/ja/town.txt', { headers: { Range: 'bytes=0-2,4-6' } }),
    { ADDRESS_DATA: state.bucket } as never,
    context(),
  )
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  assert.deepEqual(state.calls, ['manifest.json'])
})

test('allows GET only', async () => {
  const state = fakeBucket()
  const response = await worker.fetch(
    request('/manifest.json', { method: 'POST' }),
    { ADDRESS_DATA: state.bucket } as never,
    context(),
  )
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('Allow'), 'GET')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  assert.deepEqual(state.calls, [])
})

test('returns 503 when the manifest is unavailable', async () => {
  const state = fakeBucket(null)
  const response = await worker.fetch(
    request('/manifest.json'),
    { ADDRESS_DATA: state.bucket } as never,
    context(),
  )
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  assert.deepEqual(state.calls, ['manifest.json'])
})

test('serves current data with version and CORS headers', async () => {
  const state = fakeBucket()
  const response = await worker.fetch(
    request('/api/ja/town.txt'),
    { ADDRESS_DATA: state.bucket } as never,
    context(),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Data-Version'), 'v2')
  assert.equal(response.headers.get('X-Data-Cache'), 'BYPASS')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  assert.deepEqual(state.calls, ['manifest.json', 'versions/v2/api/ja/town.txt'])
})

test('serves a fixed version with immutable caching', async () => {
  const state = fakeBucket()
  const response = await worker.fetch(
    request('/versions/v1/api/ja/town.txt'),
    { ADDRESS_DATA: state.bucket } as never,
    context(),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Data-Version'), 'v1')
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  assert.deepEqual(state.calls, ['manifest.json', 'versions/v1/api/ja/town.txt'])
})

test('serves a valid Range as CORS-enabled 206 BYPASS when Cache API is unavailable', async () => {
  const state = fakeBucket()
  const response = await worker.fetch(
    request('/api/ja/town.txt', { headers: { Range: 'bytes=2-4' } }),
    { ADDRESS_DATA: state.bucket } as never,
    context(),
  )
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('Content-Range'), 'bytes 2-4/100')
  assert.equal(response.headers.get('X-Data-Cache'), 'BYPASS')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  assert.deepEqual(state.calls, ['manifest.json', 'versions/v2/api/ja/town.txt'])
})

test('rejects decoded traversal without reading a data object', async () => {
  const state = fakeBucket()
  const response = await worker.fetch(
    request('/api/ja/%5csecret.txt'),
    { ADDRESS_DATA: state.bucket } as never,
    context(),
  )
  assert.equal(response.status, 404)
  assert.deepEqual(state.calls, ['manifest.json'])
})
