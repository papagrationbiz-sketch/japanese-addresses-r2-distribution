import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseManifest,
  pruneRetiredVersions,
  retiredVersionPrefixes,
  registerVersion,
  rollbackVersion,
  switchVersion,
  versionPrefix,
} from '../src/manifest'

const rawManifest = () => ({
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
    v3: {
      prefix: 'versions/v3',
      publishedAt: '2026-10-01T00:00:00.000Z',
    },
  },
})

test('parses a valid manifest and resolves its current prefix', () => {
  assert.equal(versionPrefix(parseManifest(rawManifest())), 'versions/v2')
})

test('accepts a one-character safe prefix', () => {
  const raw = rawManifest() as any
  raw.versions.v2.prefix = 'v'
  assert.equal(parseManifest(raw).versions.v2.prefix, 'v')
})

test('switch records the old current version for rollback', () => {
  const manifest = switchVersion(
    parseManifest(rawManifest()),
    'v3',
    new Date('2026-10-02T00:00:00.000Z'),
  )
  assert.equal(manifest.current, 'v3')
  assert.equal(manifest.previous, 'v2')
  assert.equal(manifest.updatedAt, '2026-10-02T00:00:00.000Z')
})

test('rollback swaps current and previous', () => {
  const manifest = rollbackVersion(
    parseManifest(rawManifest()),
    new Date('2026-09-03T00:00:00.000Z'),
  )
  assert.equal(manifest.current, 'v1')
  assert.equal(manifest.previous, 'v2')
})

test('prune ends rollback and retains only current metadata', () => {
  const manifest = pruneRetiredVersions(
    parseManifest(rawManifest()),
    new Date('2026-09-04T00:00:00.000Z'),
  )
  assert.equal(manifest.current, 'v2')
  assert.equal(manifest.previous, 'v1')
  assert.deepEqual(Object.keys(manifest.versions), ['v1', 'v2'])
  assert.equal(manifest.updatedAt, '2026-09-04T00:00:00.000Z')
})

test('prune retains current and previous after repeated switch and rollback', () => {
  let manifest = parseManifest(rawManifest())
  manifest = switchVersion(manifest, 'v3', new Date('2026-10-02T00:00:00.000Z'))
  assert.deepEqual(retiredVersionPrefixes(manifest), ['versions/v1'])
  manifest = rollbackVersion(manifest, new Date('2026-10-03T00:00:00.000Z'))
  manifest = switchVersion(manifest, 'v3', new Date('2026-10-04T00:00:00.000Z'))
  const pruned = pruneRetiredVersions(manifest, new Date('2026-10-05T00:00:00.000Z'))
  assert.equal(pruned.current, 'v3')
  assert.equal(pruned.previous, 'v2')
  assert.deepEqual(Object.keys(pruned.versions), ['v2', 'v3'])
  assert.deepEqual(retiredVersionPrefixes(pruned), [])
})

test('retired prefixes keep both current and previous out of deletion', () => {
  const manifest = parseManifest({
    ...rawManifest(),
    current: 'v3',
    previous: 'v2',
  })
  assert.deepEqual(retiredVersionPrefixes(manifest), ['versions/v1'])
})

test('nullable previous produces no retired prefixes', () => {
  const manifest = parseManifest({ ...rawManifest(), current: 'v3', previous: null })
  assert.deepEqual(retiredVersionPrefixes(manifest), [])
})

test('retired prefix calculation rejects overlap with either rollback anchor', () => {
  const manifest = parseManifest(rawManifest()) as any
  manifest.versions.v3.prefix = 'versions/v2/nested'
  assert.throws(() => retiredVersionPrefixes(manifest), /overlapping current or previous/)
})

test('accepts and strictly validates optional integrity metadata', () => {
  const raw = rawManifest() as any
  raw.versions.v2.integrity = {
    algorithm: 'sha256',
    inventoryPath: '_integrity/sha256.json',
    inventorySha256: 'a'.repeat(64),
    fileCount: 2,
    totalBytes: 10,
  }
  assert.equal(parseManifest(raw).versions.v2.integrity?.totalBytes, 10)
  for (const integrity of [
    { ...raw.versions.v2.integrity, algorithm: 'sha1' },
    { ...raw.versions.v2.integrity, inventoryPath: '../inventory.json' },
    { ...raw.versions.v2.integrity, inventorySha256: 'A'.repeat(64) },
    { ...raw.versions.v2.integrity, fileCount: 0 },
    { ...raw.versions.v2.integrity, totalBytes: -1 },
  ]) {
    const invalid = rawManifest() as any
    invalid.versions.v2.integrity = integrity
    assert.throws(() => parseManifest(invalid))
  }
})

test('requires integrity when registering or activating national coverage', () => {
  const manifest = parseManifest(rawManifest())
  assert.throws(
    () => registerVersion(
      manifest,
      'v4',
      {
        prefix: 'versions/v4',
        publishedAt: '2026-11-01T00:00:00.000Z',
        coverage: { scope: 'national' },
      },
    ),
    /requires integrity/,
  )
  const nationalLegacy = parseManifest({
    ...rawManifest(),
    versions: {
      v1: {
        prefix: 'versions/v1',
        publishedAt: '2026-08-01T00:00:00.000Z',
        coverage: { scope: 'national' },
      },
      v2: {
        prefix: 'versions/v2',
        publishedAt: '2026-09-01T00:00:00.000Z',
      },
    },
  })
  assert.throws(() => switchVersion(nationalLegacy, 'v1'), /requires integrity/)
})

test('register adds immutable version metadata without activating it', () => {
  const manifest = registerVersion(
    parseManifest(rawManifest()),
    'v4',
    { prefix: 'versions/v4', publishedAt: '2026-11-01T00:00:00.000Z' },
    new Date('2026-11-02T00:00:00.000Z'),
  )
  assert.equal(manifest.current, 'v2')
  assert.equal(manifest.versions.v4.prefix, 'versions/v4')
  assert.equal(manifest.updatedAt, '2026-11-02T00:00:00.000Z')
  assert.throws(
    () => registerVersion(manifest, 'v4', {
      prefix: 'different',
      publishedAt: '2026-11-01T00:00:00.000Z',
    }),
    /different metadata/,
  )
})

test('new registrations must use the fixed versions/{id} storage prefix', () => {
  assert.throws(
    () => registerVersion(
      parseManifest(rawManifest()),
      'v4',
      { prefix: 'custom/v4', publishedAt: '2026-11-01T00:00:00.000Z' },
    ),
    /versions\/\{id\}/,
  )
})

test('coverage is optional and partial coverage rejects unsafe municipalities', () => {
  const base = rawManifest()
  const raw = {
    ...base,
    versions: {
      ...base.versions,
      v2: {
        ...base.versions.v2,
        coverage: {
          scope: 'municipalities',
          municipalities: ['ExamplePrefecture/ExampleMunicipality'],
        },
      },
    },
  }
  assert.deepEqual(parseManifest(raw).versions.v2.coverage, raw.versions.v2.coverage)
  raw.versions.v2.coverage.municipalities = ['ExamplePrefecture/../secret']
  assert.throws(() => parseManifest(raw), /invalid/)
})

test('rejects non-canonical timestamps', () => {
  for (const updatedAt of [
    '2026-09-02T00:00:00Z',
    '2026-09-02T09:00:00.000+09:00',
    '2026-09-02T00:00:00.000+00:00',
    '2026-02-30T00:00:00.000Z',
  ]) {
    assert.throws(() => parseManifest({ ...rawManifest(), updatedAt }), /canonical ISO/)
  }
})

test('rejects unsafe or oversized prefixes', () => {
  for (const prefix of ['../private', 'versions//v2', 'versions/v2..x', 'versions/with space']) {
    const unsafe = rawManifest()
    unsafe.versions.v2.prefix = prefix
    assert.throws(() => parseManifest(unsafe), /safe R2 prefix/)
  }
  const oversized = rawManifest()
  oversized.versions.v2.prefix = `v${'x'.repeat(512)}`
  assert.throws(() => parseManifest(oversized), /safe R2 prefix/)
})

test('rejects an unregistered current version', () => {
  assert.throws(() => parseManifest({ ...rawManifest(), current: 'missing' }), /not registered/)
})

test('rejects prefixes shared by two versions', () => {
  const raw = rawManifest()
  raw.versions.v2.prefix = raw.versions.v1.prefix
  assert.throws(() => parseManifest(raw), /overlaps/)
})

test('rejects prefixes nested under another version prefix', () => {
  const raw = rawManifest()
  raw.versions.v2.prefix = 'versions/v1/nested'
  assert.throws(() => parseManifest(raw), /overlaps/)
})
