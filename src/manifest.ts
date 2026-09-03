export const MANIFEST_KEY = 'manifest.json'

export type DataIntegrity = {
  algorithm: 'sha256'
  inventoryPath: string
  inventorySha256: string
  fileCount: number
  totalBytes: number
}

export type DataVersion = {
  prefix: string
  publishedAt: string
  sourceUpdatedAt?: string
  integrity?: DataIntegrity
  coverage?:
    | { scope: 'national' }
    | { scope: 'municipalities'; municipalities: string[] }
}

export type DataManifest = {
  schemaVersion: 1
  current: string
  previous: string | null
  updatedAt: string
  versions: Record<string, DataVersion>
}

const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PREFIX = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,510}[A-Za-z0-9._-])?$/
const INVENTORY_PATH = /^[A-Za-z0-9_-](?:[A-Za-z0-9._/-]{0,510}[A-Za-z0-9._-])?$/
const SHA256 = /^[0-9a-f]{64}$/
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertTimestamp = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) {
    throw new Error(`${field} must be a canonical ISO 8601 UTC timestamp`)
  }
  try {
    if (new Date(value).toISOString() !== value) {
      throw new Error(`${field} is not canonical`)
    }
  } catch {
    throw new Error(`${field} must be a canonical ISO 8601 UTC timestamp`)
  }
  return value
}

const assertVersionId = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !VERSION_ID.test(value)) {
    throw new Error(`${field} is not a valid version id`)
  }
  return value
}

const assertPrefix = (value: unknown, field: string): string => {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !PREFIX.test(value) ||
    value.includes('..') ||
    value.includes('//')
  ) {
    throw new Error(`${field} is not a safe R2 prefix`)
  }
  return value
}

const assertInventoryPath = (value: unknown, field: string): string => {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !INVENTORY_PATH.test(value) ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) {
    throw new Error(`${field} is not a safe inventory path`)
  }
  return value
}

const parseIntegrity = (value: unknown, field: string): DataIntegrity => {
  if (!isRecord(value) || value.algorithm !== 'sha256') {
    throw new Error(`${field}.algorithm must be sha256`)
  }
  const inventoryPath = assertInventoryPath(value.inventoryPath, `${field}.inventoryPath`)
  if (typeof value.inventorySha256 !== 'string' || !SHA256.test(value.inventorySha256)) {
    throw new Error(`${field}.inventorySha256 must be lowercase SHA-256`)
  }
  if (
    typeof value.fileCount !== 'number' ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount <= 0
  ) {
    throw new Error(`${field}.fileCount must be a positive safe integer`)
  }
  if (
    typeof value.totalBytes !== 'number' ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0
  ) {
    throw new Error(`${field}.totalBytes must be a non-negative safe integer`)
  }
  return {
    algorithm: 'sha256',
    inventoryPath,
    inventorySha256: value.inventorySha256,
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
  }
}

const parseCoverage = (value: unknown, field: string): DataVersion['coverage'] => {
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  if (value.scope === 'national') return { scope: 'national' }
  if (
    value.scope !== 'municipalities' ||
    !Array.isArray(value.municipalities) ||
    value.municipalities.length === 0
  ) {
    throw new Error(`${field} must declare national or non-empty municipalities`)
  }
  const municipalities = value.municipalities.map((entry, index) => {
    if (
      typeof entry !== 'string' ||
      !/^[^/]+\/[^/]+$/.test(entry) ||
      entry.includes('..') ||
      entry.includes('\\') ||
      entry.includes('\0') ||
      [...entry].some((character) => character.charCodeAt(0) < 0x20)
    ) {
      throw new Error(`${field}.municipalities.${index} is invalid`)
    }
    return entry
  })
  if (new Set(municipalities).size !== municipalities.length) {
    throw new Error(`${field}.municipalities contains duplicates`)
  }
  return { scope: 'municipalities', municipalities }
}

export function parseManifest(value: unknown): DataManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('manifest schemaVersion must be 1')
  }
  if (!isRecord(value.versions) || Object.keys(value.versions).length === 0) {
    throw new Error('manifest versions must not be empty')
  }

  const versions: Record<string, DataVersion> = {}
  for (const [id, rawVersion] of Object.entries(value.versions)) {
    assertVersionId(id, `versions.${id}`)
    if (!isRecord(rawVersion)) throw new Error(`versions.${id} must be an object`)
    const version: DataVersion = {
      prefix: assertPrefix(rawVersion.prefix, `versions.${id}.prefix`),
      publishedAt: assertTimestamp(rawVersion.publishedAt, `versions.${id}.publishedAt`),
    }
    if (rawVersion.sourceUpdatedAt !== undefined) {
      version.sourceUpdatedAt = assertTimestamp(
        rawVersion.sourceUpdatedAt,
        `versions.${id}.sourceUpdatedAt`,
      )
    }
    if (rawVersion.coverage !== undefined) {
      version.coverage = parseCoverage(rawVersion.coverage, `versions.${id}.coverage`)
    }
    if (rawVersion.integrity !== undefined) {
      version.integrity = parseIntegrity(rawVersion.integrity, `versions.${id}.integrity`)
    }
    versions[id] = version
  }

  const prefixOwners = new Map<string, string>()
  for (const [id, version] of Object.entries(versions)) {
    for (const [prefix, owner] of prefixOwners) {
      if (
        version.prefix === prefix ||
        version.prefix.startsWith(`${prefix}/`) ||
        prefix.startsWith(`${version.prefix}/`)
      ) {
        throw new Error(`versions.${id}.prefix overlaps versions.${owner}.prefix`)
      }
    }
    prefixOwners.set(version.prefix, id)
  }

  const current = assertVersionId(value.current, 'current')
  if (!versions[current]) throw new Error(`current version is not registered: ${current}`)

  let previous: string | null = null
  if (value.previous !== null && value.previous !== undefined) {
    previous = assertVersionId(value.previous, 'previous')
    if (!versions[previous]) throw new Error(`previous version is not registered: ${previous}`)
    if (previous === current) throw new Error('previous must differ from current')
  }

  return {
    schemaVersion: 1,
    current,
    previous,
    updatedAt: assertTimestamp(value.updatedAt, 'updatedAt'),
    versions,
  }
}

export function switchVersion(
  manifest: DataManifest,
  target: string,
  now = new Date(),
): DataManifest {
  assertVersionId(target, 'target')
  const targetVersion = manifest.versions[target]
  if (!targetVersion) throw new Error(`target version is not registered: ${target}`)
  if (targetVersion.coverage?.scope === 'national' && !targetVersion.integrity) {
    throw new Error('national target version requires integrity metadata')
  }
  if (target === manifest.current) return manifest
  return {
    ...manifest,
    current: target,
    previous: manifest.current,
    updatedAt: now.toISOString(),
  }
}

export function registerVersion(
  manifest: DataManifest,
  id: string,
  version: DataVersion,
  now = new Date(),
): DataManifest {
  assertVersionId(id, 'version')
  const existing = manifest.versions[id]
  if (!existing && version.prefix !== `versions/${id}`) {
    throw new Error('new versions must use prefix versions/{id}')
  }
  const validated = parseManifest({
    ...manifest,
    updatedAt: now.toISOString(),
    versions: { ...manifest.versions, [id]: version },
  })
  if (version.coverage?.scope === 'national' && !version.integrity) {
    throw new Error('national version registration requires integrity metadata')
  }
  if (existing && JSON.stringify(existing) !== JSON.stringify(validated.versions[id])) {
    throw new Error(`version is already registered with different metadata: ${id}`)
  }
  return existing ? manifest : validated
}

export function rollbackVersion(manifest: DataManifest, now = new Date()): DataManifest {
  if (!manifest.previous) throw new Error('manifest has no previous version')
  const target = manifest.versions[manifest.previous]
  if (target?.coverage?.scope === 'national' && !target.integrity) {
    throw new Error('national rollback target requires integrity metadata')
  }
  return {
    ...manifest,
    current: manifest.previous,
    previous: manifest.current,
    updatedAt: now.toISOString(),
  }
}

export function pruneRetiredVersions(manifest: DataManifest, now = new Date()): DataManifest {
  return pruneOlderVersions(manifest, now)
}

/** Keep current and previous metadata; remove only versions older than previous. */
export function pruneOlderVersions(manifest: DataManifest, now = new Date()): DataManifest {
  if (!manifest.previous) return { ...manifest, updatedAt: now.toISOString() }
  const retained = new Set([manifest.current, manifest.previous])
  return {
    ...manifest,
    updatedAt: now.toISOString(),
    versions: Object.fromEntries(
      Object.entries(manifest.versions).filter(([id]) => retained.has(id)),
    ),
  }
}

/** Return only safe prefixes that are older than the current rollback anchor. */
export function retiredVersionPrefixes(manifest: DataManifest): string[] {
  if (!manifest.previous) return []
  const anchorIDs = [manifest.current, manifest.previous]
  const anchorPrefixes = anchorIDs.map((id) => {
    const prefix = manifest.versions[id]?.prefix
    if (!prefix || !safePrefix(prefix)) {
      throw new Error('manifest contains an unsafe current or previous version prefix')
    }
    return prefix
  })
  const retired: string[] = []
  return Object.entries(manifest.versions)
    .filter(([id]) => id !== manifest.current && id !== manifest.previous)
    .map(([id, version]) => {
      if (!VERSION_ID.test(id) || !safePrefix(version.prefix)) {
        throw new Error('manifest contains an unsafe retired version prefix')
      }
      if (anchorPrefixes.some((anchor) => prefixesOverlap(anchor, version.prefix))) {
        throw new Error('manifest contains a retired prefix overlapping current or previous')
      }
      if (retired.some((prefix) => prefixesOverlap(prefix, version.prefix))) {
        throw new Error('manifest contains overlapping retired version prefixes')
      }
      retired.push(version.prefix)
      return version.prefix
    })
    .sort()
}

export function versionPrefix(manifest: DataManifest, version = manifest.current): string {
  const entry = manifest.versions[version]
  if (!entry) throw new Error(`version is not registered: ${version}`)
  return entry.prefix
}

function safePrefix(value: string): boolean {
  return (
    value.length <= 512 &&
    PREFIX.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.includes('\\')
  )
}

function prefixesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
