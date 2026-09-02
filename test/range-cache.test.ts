import assert from 'node:assert/strict'
import test from 'node:test'
import {
  makeRangeCacheKey,
  parseSingleByteRange,
  serveRangeWithCache,
  type CacheLike,
} from '../src/range-cache'

class FakeCache {
  readonly entries = new Map<string, Response>()
  putCount = 0
  rejectPut = false

  async match(key: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(String(key))?.clone()
  }

  async put(key: RequestInfo | URL, response: Response): Promise<void> {
    this.putCount += 1
    if (response.status !== 200) throw new Error('partial responses must not be cached')
    if (this.rejectPut) throw new Error('cache unavailable')
    this.entries.set(String(key), response.clone())
  }

  asCache(): CacheLike {
    return this
  }
}

function fakeBucket() {
  const calls: Array<{ key: string; options: unknown }> = []
  const bucket = {
    async get(key: string, options?: unknown) {
      calls.push({ key, options })
      const range = (options as { range?: { offset: number; length: number } } | undefined)?.range
      const offset = range?.offset ?? 0
      const length = range?.length ?? 10
      const body = new Uint8Array(Array.from({ length }, (_, index) => offset + index))
      return {
        body: new Response(body).body,
        size: 100,
        range: { offset, length },
        httpEtag: '"range-etag"',
        writeHttpMetadata(headers: Headers) {
          headers.set('Content-Type', 'application/octet-stream')
        },
      }
    },
  }
  return { bucket: bucket as never, calls }
}

function fakeContext() {
  const pending: Promise<unknown>[] = []
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise)
      },
    },
    async drain() {
      await Promise.all(pending)
    },
  }
}

test('accepts only one explicit start-end byte range', () => {
  assert.deepEqual(parseSingleByteRange('bytes=10-14'), { start: 10, end: 14 })
  for (const value of [
    null,
    'bytes=10-',
    'bytes=-14',
    'bytes=10-14,20-24',
    'bytes=14-10',
    'bytes=1-9007199254740992',
  ]) {
    assert.equal(parseSingleByteRange(value), null)
  }
})

test('cache keys do not collide across origin, version, object, or range', () => {
  const first = makeRangeCacheKey(
    'https://one.example',
    'v1',
    'v1/api/ja/town.txt',
    { start: 10, end: 14 },
  )
  assert.notEqual(
    first,
    makeRangeCacheKey('https://two.example', 'v1', 'v1/api/ja/town.txt', { start: 10, end: 14 }),
  )
  assert.notEqual(
    first,
    makeRangeCacheKey('https://one.example', 'v2', 'v1/api/ja/town.txt', { start: 10, end: 14 }),
  )
  assert.notEqual(
    first,
    makeRangeCacheKey('https://one.example', 'v1', 'v2/api/ja/town.txt', { start: 10, end: 14 }),
  )
  assert.notEqual(
    first,
    makeRangeCacheKey('https://one.example', 'v1', 'v1/api/ja/town.txt', { start: 11, end: 15 }),
  )
})

test('stores an internal 200 and reconstructs a public 206 on HIT', async () => {
  const cache = new FakeCache()
  const { bucket, calls } = fakeBucket()
  const context = fakeContext()
  const args = {
    bucket,
    cache: cache.asCache(),
    ctx: context.ctx,
    cacheOrigin: 'https://data.example',
    key: 'v1/api/ja/town.txt',
    version: 'v1',
    range: { start: 10, end: 14 },
    cacheControl: 'public, max-age=60, must-revalidate',
  }

  const miss = await serveRangeWithCache(args)
  await context.drain()
  assert.equal(miss.status, 206)
  assert.equal(miss.headers.get('Content-Range'), 'bytes 10-14/100')
  assert.equal(miss.headers.get('Content-Length'), '5')
  assert.equal(miss.headers.get('X-Data-Cache'), 'MISS')
  assert.equal(miss.headers.get('Access-Control-Allow-Origin'), '*')
  assert.deepEqual(Array.from(new Uint8Array(await miss.arrayBuffer())), [10, 11, 12, 13, 14])
  assert.equal(cache.putCount, 1)
  assert.equal([...cache.entries.values()][0].status, 200)

  const hit = await serveRangeWithCache(args)
  assert.equal(hit.status, 206)
  assert.equal(hit.headers.get('Content-Range'), 'bytes 10-14/100')
  assert.equal(hit.headers.get('X-Data-Cache'), 'HIT')
  assert.equal(hit.headers.get('Access-Control-Allow-Origin'), '*')
  assert.deepEqual(Array.from(new Uint8Array(await hit.arrayBuffer())), [10, 11, 12, 13, 14])
  assert.equal(calls.length, 1)
})

test('cache write failure does not break the R2 response', async () => {
  const cache = new FakeCache()
  cache.rejectPut = true
  const { bucket } = fakeBucket()
  const context = fakeContext()
  const response = await serveRangeWithCache({
    bucket,
    cache: cache.asCache(),
    ctx: context.ctx,
    cacheOrigin: 'https://data.example',
    key: 'v1/api/ja.json',
    version: 'v1',
    range: { start: 0, end: 2 },
    cacheControl: 'public, max-age=60',
  })
  await context.drain()
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('X-Data-Cache'), 'MISS')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  assert.equal(await response.text(), '\x00\x01\x02')
})
