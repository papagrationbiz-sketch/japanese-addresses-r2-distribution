import { MANIFEST_KEY, parseManifest, versionPrefix, type DataManifest } from './manifest'
import { parseSingleByteRange, serveRangeWithCache } from './range-cache'

const jsonHeaders = (cacheControl: string): Headers => {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  })
  headers.set('Access-Control-Allow-Origin', '*')
  return headers
}

async function loadManifest(bucket: R2Bucket): Promise<DataManifest> {
  const object = await bucket.get(MANIFEST_KEY)
  if (!object) throw new Error(`${MANIFEST_KEY} is missing`)
  return parseManifest(await object.json())
}

function dataSuffix(pathname: string): string | null {
  if (pathname === '/api/ja.json') return 'ja.json'
  if (!pathname.startsWith('/api/ja/')) return null

  let suffix: string
  try {
    suffix = decodeURIComponent(pathname.slice('/api/ja/'.length))
  } catch {
    return null
  }
  if (
    !suffix ||
    suffix.startsWith('/') ||
    suffix.includes('..') ||
    suffix.includes('\\') ||
    suffix.includes('\0')
  ) {
    return null
  }
  return `ja/${suffix}`
}

function invalidRangeResponse(): Response {
  return new Response('Only one explicit byte range is supported', {
    status: 400,
    headers: {
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

async function serveObject(
  bucket: R2Bucket,
  key: string,
  cacheControl: string,
  version: string,
): Promise<Response> {
  const object = await bucket.get(key)
  if (!object) return new Response('Not found', { status: 404 })

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Content-Type', headers.get('Content-Type') || 'application/octet-stream')
  headers.set('Cache-Control', cacheControl)
  headers.set('ETag', object.httpEtag)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Content-Length', String(object.size))
  headers.set('X-Data-Cache', 'BYPASS')
  headers.set('X-Data-Version', version)
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(object.body, { headers })
}

function isDataPath(pathname: string): boolean {
  return pathname === '/api/ja.json' || pathname.startsWith('/api/ja/')
}

function isPinnedPath(pathname: string): boolean {
  return /^\/versions\/[^/]+\/api\/ja(?:\.json|\/.*)$/.test(pathname)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET', 'Access-Control-Allow-Origin': '*' },
      })
    }
    if (
      url.pathname !== '/manifest.json' &&
      !isDataPath(url.pathname) &&
      !isPinnedPath(url.pathname)
    ) {
      return new Response('Not found', { status: 404 })
    }

    let manifest: DataManifest
    try {
      manifest = await loadManifest(env.ADDRESS_DATA)
    } catch {
      return Response.json(
        { error: 'data manifest is unavailable' },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
        },
      )
    }
    if (url.pathname === '/manifest.json') {
      return new Response(JSON.stringify(manifest), {
        headers: jsonHeaders('public, max-age=60, must-revalidate'),
      })
    }

    let version = manifest.current
    let pathname = url.pathname
    const pinned = pathname.match(/^\/versions\/([^/]+)(\/api\/ja(?:\.json|\/.*))$/)
    if (pinned) {
      version = pinned[1]
      pathname = pinned[2]
      if (!manifest.versions[version]) {
        return new Response('Version not found', {
          status: 404,
          headers: { 'Access-Control-Allow-Origin': '*' },
        })
      }
    }

    const suffix = dataSuffix(pathname)
    if (!suffix) return new Response('Not found', { status: 404 })
    const immutable = version !== manifest.current || url.pathname.startsWith('/versions/')
    const key = `${versionPrefix(manifest, version)}/api/${suffix}`
    const cacheControl = immutable
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=60, must-revalidate'

    const rangeHeader = request.headers.get('Range')
    if (rangeHeader !== null) {
      const range = parseSingleByteRange(rangeHeader)
      if (!range) return invalidRangeResponse()

      let cache: Cache | undefined
      try {
        cache = await caches.open('japanese-addresses-range-v1')
      } catch {
        // Cache is best effort.
      }
      return serveRangeWithCache({
        bucket: env.ADDRESS_DATA,
        cache,
        ctx,
        cacheOrigin: url.origin,
        key,
        version,
        range,
        cacheControl,
      })
    }
    return serveObject(env.ADDRESS_DATA, key, cacheControl, version)
  },
}
