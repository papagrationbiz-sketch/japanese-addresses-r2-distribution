/** Cache API support for exact, single-byte ranges. */

export type ByteRange = {
  start: number
  end: number
}

export type CacheLike = Pick<Cache, 'match' | 'put'>
export type RangeCacheContext = Pick<ExecutionContext, 'waitUntil'>

export type RangeCacheObject = {
  body: ReadableStream<Uint8Array> | null
  size: number
  range?: R2Range
  httpEtag: string
  writeHttpMetadata(headers: Headers): void
}

const INTERNAL_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const RANGE_METADATA = {
  offset: 'X-Data-Range-Offset',
  length: 'X-Data-Range-Length',
  total: 'X-Data-Object-Size',
}

const addCors = (headers: Headers): void => {
  headers.set('Access-Control-Allow-Origin', '*')
}

/** Parse only RFC `bytes=start-end`; suffix, open-ended, and multi-ranges are unsupported. */
export function parseSingleByteRange(value: string | null): ByteRange | null {
  if (value === null) return null
  const match = /^bytes=(\d+)-(\d+)$/.exec(value)
  if (!match) return null

  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null
  return { start, end }
}

export function makeRangeCacheKey(
  cacheOrigin: string,
  version: string,
  objectKey: string,
  range: ByteRange,
): string {
  const origin = new URL(cacheOrigin)
  if (
    (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  ) {
    throw new Error('cacheOrigin must be a URL origin')
  }
  return `${origin.origin}/partial/${encodeURIComponent(version)}/${encodeURIComponent(objectKey)}?range=${range.start}-${range.end}`
}

function normalizedObjectRange(
  object: RangeCacheObject,
  requested: ByteRange,
): { offset: number; length: number } {
  if (
    object.range &&
    'offset' in object.range &&
    typeof object.range.offset === 'number' &&
    typeof object.range.length === 'number' &&
    object.range.length > 0
  ) {
    return { offset: object.range.offset, length: object.range.length }
  }
  return { offset: requested.start, length: requested.end - requested.start + 1 }
}

function cacheResponseHeaders(object: RangeCacheObject, range: ByteRange): Headers {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Content-Type', headers.get('Content-Type') || 'application/octet-stream')
  headers.set('Cache-Control', INTERNAL_CACHE_CONTROL)
  headers.set('ETag', object.httpEtag)
  const objectRange = normalizedObjectRange(object, range)
  headers.set(RANGE_METADATA.offset, String(objectRange.offset))
  headers.set(RANGE_METADATA.length, String(objectRange.length))
  headers.set(RANGE_METADATA.total, String(object.size))
  addCors(headers)
  return headers
}

function readIntegerHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function responseFromCachedPartial(
  cached: Response,
  version: string,
  cacheControl: string,
): Response | null {
  if (cached.status !== 200) return null
  const offset = readIntegerHeader(cached.headers, RANGE_METADATA.offset)
  const length = readIntegerHeader(cached.headers, RANGE_METADATA.length)
  const total = readIntegerHeader(cached.headers, RANGE_METADATA.total)
  if (
    offset === null ||
    length === null ||
    total === null ||
    length === 0 ||
    !Number.isSafeInteger(offset + length) ||
    offset + length > total
  ) {
    return null
  }

  const headers = new Headers(cached.headers)
  headers.delete(RANGE_METADATA.offset)
  headers.delete(RANGE_METADATA.length)
  headers.delete(RANGE_METADATA.total)
  headers.set('Cache-Control', cacheControl)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${total}`)
  headers.set('Content-Length', String(length))
  headers.set('X-Data-Version', version)
  headers.set('X-Data-Cache', 'HIT')
  addCors(headers)
  return new Response(cached.body, { status: 206, headers })
}

export async function serveRangeWithCache(args: {
  bucket: R2Bucket
  cache: CacheLike | undefined
  ctx: RangeCacheContext | undefined
  cacheOrigin: string
  key: string
  version: string
  range: ByteRange
  cacheControl: string
}): Promise<Response> {
  const { bucket, cache, ctx, cacheOrigin, key, version, range, cacheControl } = args
  if (!cache) return serveR2Range(bucket, key, version, range, cacheControl)

  const cacheKey = makeRangeCacheKey(cacheOrigin, version, key, range)
  let cached: Response | undefined
  try {
    cached = (await cache.match(cacheKey)) ?? undefined
  } catch {
    // Cache is an optimization. Continue with an origin read when unavailable.
  }
  if (cached) {
    const hit = responseFromCachedPartial(cached, version, cacheControl)
    if (hit) return hit
  }

  const object = await bucket.get(key, {
    range: { offset: range.start, length: range.end - range.start + 1 },
  })
  if (!object) {
    return new Response('Not found', {
      status: 404,
      headers: { 'X-Data-Cache': 'MISS', 'Access-Control-Allow-Origin': '*' },
    })
  }

  const partialRange = normalizedObjectRange(object, range)
  const internal = new Response(object.body, {
    status: 200,
    headers: cacheResponseHeaders(object, range),
  })
  if (ctx) {
    try {
      ctx.waitUntil(cache.put(cacheKey, internal.clone()).catch(() => undefined))
    } catch {
      // Ignore cache failures; the R2 response remains usable.
    }
  }

  const headers = new Headers(internal.headers)
  headers.delete(RANGE_METADATA.offset)
  headers.delete(RANGE_METADATA.length)
  headers.delete(RANGE_METADATA.total)
  headers.set('Cache-Control', cacheControl)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Content-Range', `bytes ${partialRange.offset}-${partialRange.offset + partialRange.length - 1}/${object.size}`)
  headers.set('Content-Length', String(partialRange.length))
  headers.set('X-Data-Version', version)
  headers.set('X-Data-Cache', 'MISS')
  addCors(headers)
  return new Response(internal.body, { status: 206, headers })
}

async function serveR2Range(
  bucket: R2Bucket,
  key: string,
  version: string,
  range: ByteRange,
  cacheControl: string,
): Promise<Response> {
  const object = await bucket.get(key, {
    range: { offset: range.start, length: range.end - range.start + 1 },
  })
  if (!object) {
    return new Response('Not found', {
      status: 404,
      headers: { 'X-Data-Cache': 'BYPASS', 'Access-Control-Allow-Origin': '*' },
    })
  }

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Content-Type', headers.get('Content-Type') || 'application/octet-stream')
  headers.set('Cache-Control', cacheControl)
  headers.set('ETag', object.httpEtag)
  headers.set('Accept-Ranges', 'bytes')
  const objectRange = normalizedObjectRange(object, range)
  headers.set('Content-Range', `bytes ${objectRange.offset}-${objectRange.offset + objectRange.length - 1}/${object.size}`)
  headers.set('Content-Length', String(objectRange.length))
  headers.set('X-Data-Version', version)
  headers.set('X-Data-Cache', 'BYPASS')
  addCors(headers)
  return new Response(object.body, { status: 206, headers })
}
