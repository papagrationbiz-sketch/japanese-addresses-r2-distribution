import { parseManifest } from '../src/manifest'

export type SmokeFetch = (input: string, init?: RequestInit) => Promise<Response>

function baseURL(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base URL must use HTTP or HTTPS')
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('base URL must not contain credentials, query, fragment, or a trailing slash')
  }
  return url
}

async function requireResponse(
  response: Response,
  expectedStatus: number,
  path: string,
): Promise<void> {
  if (response.status !== expectedStatus) {
    throw new Error(`${path}: expected HTTP ${expectedStatus}, got ${response.status}`)
  }
}

function requireImmutable(response: Response, path: string): void {
  if (!response.headers.get('Cache-Control')?.includes('immutable')) {
    throw new Error(`${path}: immutable Cache-Control is missing`)
  }
  if (!response.headers.get('ETag')) throw new Error(`${path}: ETag is missing`)
  const length = Number(response.headers.get('Content-Length'))
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error(`${path}: positive Content-Length is required`)
  }
}

export async function runPublicSmoke(
  input: string,
  expectedVersion?: string,
  fetchImpl: SmokeFetch = (globalThis.fetch as SmokeFetch),
): Promise<{ version: string; fixedPath: string }> {
  const base = baseURL(input)
  const manifestResponse = await fetchImpl(new URL('/manifest.json', base).toString())
  await requireResponse(manifestResponse, 200, '/manifest.json')
  const manifestCacheControl = (manifestResponse.headers.get('Cache-Control') ?? '').toLowerCase()
  if (manifestCacheControl.includes('immutable')) {
    throw new Error('/manifest.json must not use immutable caching')
  }
  if (!/(?:^|,|\s)(?:no-cache|no-store|must-revalidate)(?:=|,|\s|$)/.test(manifestCacheControl)) {
    throw new Error('/manifest.json must use revalidation or no-store caching')
  }
  const manifest = parseManifest(await manifestResponse.json())
  if (expectedVersion !== undefined && manifest.current !== expectedVersion) {
    throw new Error(`manifest current version ${manifest.current} does not match expected ${expectedVersion}`)
  }
  const fixedPath = `/versions/${manifest.current}/api/ja.json`
  const fixedURL = new URL(fixedPath, base).toString()

  const fullResponse = await fetchImpl(fixedURL)
  await requireResponse(fullResponse, 200, fixedPath)
  requireImmutable(fullResponse, fixedPath)
  const etag = fullResponse.headers.get('ETag')
  const fullLength = Number(fullResponse.headers.get('Content-Length'))

  const rangeResponse = await fetchImpl(fixedURL, { headers: { Range: 'bytes=0-0' } })
  await requireResponse(rangeResponse, 206, `${fixedPath} Range`)
  requireImmutable(rangeResponse, `${fixedPath} Range`)
  if (rangeResponse.headers.get('ETag') !== etag) {
    throw new Error(`${fixedPath} Range: ETag does not match full response`)
  }
  const contentRange = rangeResponse.headers.get('Content-Range')
  if (!contentRange || contentRange !== `bytes 0-0/${fullLength}`) {
    throw new Error(`${fixedPath} Range: exact Content-Range bytes 0-0 is required`)
  }
  if (rangeResponse.headers.get('Content-Length') !== '1') {
    throw new Error(`${fixedPath} Range: Content-Length must be 1`)
  }
  return { version: manifest.current, fixedPath }
}

if (process.argv[1]?.endsWith('/smoke-public.mts')) {
  const input = process.argv[2]
  if (!input) throw new Error('Usage: smoke-public <base-url> [expected-version]')
  console.log(JSON.stringify({ ok: true, ...(await runPublicSmoke(input, process.argv[3])) }))
}
