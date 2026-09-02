import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseManifest,
  pruneRetiredVersions,
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
  const raw = rawManifest()
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
  assert.equal(manifest.previous, null)
  assert.deepEqual(Object.keys(manifest.versions), ['v2'])
  assert.equal(manifest.updatedAt, '2026-09-04T00:00:00.000Z')
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
