export type AccuracyFetch = (input: string, init?: RequestInit) => Promise<Response>

export type Point = [number, number]

export interface TownRecord {
  oaza_cho?: string
  chome?: string
  koaza?: string
  point?: Point
}

export interface CityRecord {
  city?: string
  ward?: string
}

export interface AccuracyCase {
  pref: string
  city: string
  ward?: string
  town: string
  query: string
  abr: Point
}

export interface AccuracyResult {
  query: string
  pref: string
  abr: Point
  gsi: Point | null
  distanceMeters: number | null
  error?: string
}

export interface AccuracySummary {
  base: string
  version: string
  caseCount: number
  gsiResolved: number
  gsiUnresolved: number
  distanceMeters: {
    min: number | null
    median: number | null
    p90: number | null
    max: number | null
  }
  within500m: number
  within1000m: number
  over5000m: number
}

const GSI_SEARCH = 'https://msearch.gsi.go.jp/address-search/AddressSearch'

/**
 * Structural edge cases that a per-prefecture sample does not reliably cover:
 * an ordinance-designated ward, a remote island city, and an island town.
 */
const FIXED_CASES: { pref: string; city: string; ward?: string }[] = [
  { pref: '北海道', city: '札幌市', ward: '中央区' },
  { pref: '沖縄県', city: '石垣市' },
  { pref: '東京都', city: '八丈町' },
]

function apiPrefix(base: string, version: string): string {
  const url = new URL(base)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base URL must use HTTP or HTTPS')
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('base URL must not contain credentials, query, fragment, or a path')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version)) throw new Error('invalid version')
  return `${url.origin}/versions/${version}/api`
}

/**
 * FNV-1a over the seed string. Sampling must be deterministic so that a rerun
 * compares exactly the same addresses as the recorded acceptance run.
 */
export function pickIndex(seed: string, length: number): number {
  if (length <= 0) throw new Error('length must be positive')
  let hash = 2166136261
  for (const character of seed) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash) % length
}

export function townLabel(town: TownRecord): string {
  return `${town.oaza_cho ?? ''}${town.chome ?? ''}${town.koaza ?? ''}`
}

export function haversineMeters(a: Point, b: Point): number {
  const earthRadius = 6371008.8
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180
  const [lon1, lat1] = a
  const [lon2, lat2] = b
  const deltaLat = toRadians(lat2 - lat1)
  const deltaLon = toRadians(lon2 - lon1)
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)))
}

async function getJson<T>(fetchImpl: AccuracyFetch, url: string): Promise<T> {
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return (await response.json()) as T
}

function cityPath(city: CityRecord): string {
  return city.ward ? `${city.city}${city.ward}` : `${city.city}`
}

async function buildCase(
  fetchImpl: AccuracyFetch,
  prefix: string,
  pref: string,
  city: CityRecord,
  seed: string,
): Promise<AccuracyCase | null> {
  if (!city.city) return null
  const path = cityPath(city)
  let towns: { data: TownRecord[] }
  try {
    towns = await getJson<{ data: TownRecord[] }>(
      fetchImpl,
      `${prefix}/ja/${encodeURIComponent(pref)}/${encodeURIComponent(path)}.json`,
    )
  } catch {
    // Upstream omits a municipality JSON when it has no town data at all.
    return null
  }
  const usable = towns.data.filter((town) => town.point && townLabel(town).length > 0)
  if (usable.length === 0) return null
  const town = usable[pickIndex(seed, usable.length)]!
  const label = townLabel(town)
  return { pref, city: city.city, ward: city.ward, town: label, query: `${pref}${path}${label}`, abr: town.point! }
}

/**
 * One deterministic case per prefecture plus the fixed structural cases.
 * `candidateLimit` bounds how many municipalities are tried per prefecture
 * before giving up, because a picked municipality may have no town data.
 */
export async function selectCases(
  fetchImpl: AccuracyFetch,
  prefix: string,
  candidateLimit = 25,
): Promise<AccuracyCase[]> {
  const root = await getJson<{ data: { pref: string }[] }>(fetchImpl, `${prefix}/ja.json`)
  const cases: AccuracyCase[] = []

  for (const { pref } of root.data) {
    const cities = await getJson<{ data: CityRecord[] }>(
      fetchImpl,
      `${prefix}/ja/${encodeURIComponent(pref)}.json`,
    )
    const usable = cities.data.filter((city) => city.city)
    if (usable.length === 0) continue
    for (let candidate = 0; candidate < candidateLimit; candidate += 1) {
      const city = usable[pickIndex(`${pref}#${candidate}`, usable.length)]!
      const built = await buildCase(
        fetchImpl,
        prefix,
        pref,
        city,
        `${pref}/${cityPath(city)}#${candidate}`,
      )
      if (built) {
        cases.push(built)
        break
      }
    }
  }

  for (const fixed of FIXED_CASES) {
    const built = await buildCase(
      fetchImpl,
      prefix,
      fixed.pref,
      { city: fixed.city, ward: fixed.ward },
      `fixed/${fixed.pref}/${fixed.city}${fixed.ward ?? ''}`,
    )
    if (built && !cases.some((existing) => existing.query === built.query)) cases.push(built)
  }

  return cases
}

export async function gsiLookup(
  fetchImpl: AccuracyFetch,
  query: string,
  attempts = 3,
): Promise<Point | null> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(`${GSI_SEARCH}?q=${encodeURIComponent(query)}`)
    if (response.ok) {
      const hits = (await response.json()) as { geometry?: { coordinates?: Point } }[]
      const coordinates = hits?.[0]?.geometry?.coordinates
      return Array.isArray(coordinates) && coordinates.length === 2
        ? [Number(coordinates[0]), Number(coordinates[1])]
        : null
    }
    if (attempt === attempts) throw new Error(`GSI ${response.status} for ${query}`)
  }
  return null
}

export function summarize(
  base: string,
  version: string,
  results: AccuracyResult[],
): AccuracySummary {
  const distances = results
    .map((result) => result.distanceMeters)
    .filter((distance): distance is number => typeof distance === 'number')
    .sort((a, b) => a - b)
  const quantile = (q: number): number | null =>
    distances.length === 0 ? null : distances[Math.min(distances.length - 1, Math.floor(q * distances.length))]!
  return {
    base,
    version,
    caseCount: results.length,
    gsiResolved: distances.length,
    gsiUnresolved: results.length - distances.length,
    distanceMeters: {
      min: distances[0] ?? null,
      median: quantile(0.5),
      p90: quantile(0.9),
      max: distances.at(-1) ?? null,
    },
    within500m: distances.filter((distance) => distance <= 500).length,
    within1000m: distances.filter((distance) => distance <= 1000).length,
    over5000m: distances.filter((distance) => distance > 5000).length,
  }
}

export async function runAccuracyCheck(options: {
  base: string
  version: string
  fetchImpl?: AccuracyFetch
  delayMs?: number
  candidateLimit?: number
}): Promise<{ summary: AccuracySummary; results: AccuracyResult[] }> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as AccuracyFetch)
  const delayMs = options.delayMs ?? 250
  const prefix = apiPrefix(options.base, options.version)
  const cases = await selectCases(fetchImpl, prefix, options.candidateLimit)

  const results: AccuracyResult[] = []
  for (const accuracyCase of cases) {
    let gsi: Point | null = null
    let error: string | undefined
    try {
      gsi = await gsiLookup(fetchImpl, accuracyCase.query)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    results.push({
      query: accuracyCase.query,
      pref: accuracyCase.pref,
      abr: accuracyCase.abr,
      gsi,
      distanceMeters: gsi ? Math.round(haversineMeters(accuracyCase.abr, gsi)) : null,
      ...(error === undefined ? {} : { error }),
    })
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  return { summary: summarize(options.base, options.version, results), results }
}

if (process.argv[1]?.endsWith('/accuracy-check.mts')) {
  const [base, version, outputPath] = process.argv.slice(2)
  if (!base || !version) {
    throw new Error('Usage: accuracy-check <public-base-url> <version> [output-file]')
  }
  const report = await runAccuracyCheck({ base, version })
  if (outputPath) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  console.log(JSON.stringify(report.summary, null, 2))
}
