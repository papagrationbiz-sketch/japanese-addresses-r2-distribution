import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { DataManifest } from '../src/manifest'

const execFileAsync = promisify(execFile)
const cli = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
const manifestScript = join(process.cwd(), 'scripts/manifest.mts')

const initialManifest = {
  schemaVersion: 1,
  current: 'v1',
  previous: null,
  updatedAt: '2026-09-02T00:00:00.000Z',
  versions: {
    v1: {
      prefix: 'versions/v1',
      publishedAt: '2026-09-02T00:00:00.000Z',
    },
  },
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'japanese-addresses-cli-test-'))
  const manifestPath = join(directory, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(initialManifest)}\n`, 'utf8')
  return { directory, manifestPath }
}

async function runCli(...args: string[]): Promise<void> {
  await execFileAsync(process.execPath, [cli, manifestScript, ...args], {
    cwd: process.cwd(),
  })
}

async function runCliFailure(...args: string[]): Promise<void> {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, manifestScript, ...args], {
      cwd: process.cwd(),
    }),
  )
}

test('register without coverage keeps coverage unknown', async () => {
  const { manifestPath } = await setup()
  await runCli('register', manifestPath, 'v2', 'versions/v2', '2026-09-03T00:00:00.000Z')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DataManifest
  assert.equal(manifest.versions.v2.coverage, undefined)
})

test('register accepts explicit national coverage', async () => {
  const { manifestPath } = await setup()
  await runCli(
    'register',
    manifestPath,
    'v2',
    'versions/v2',
    '2026-09-03T00:00:00.000Z',
    '--coverage',
    'national',
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DataManifest
  assert.deepEqual(manifest.versions.v2.coverage, { scope: 'national' })
})

test('register accepts a municipality coverage file', async () => {
  const { directory, manifestPath } = await setup()
  const coveragePath = join(directory, 'municipalities.json')
  await writeFile(
    coveragePath,
    JSON.stringify({ municipalities: ['ExamplePrefecture/ExampleMunicipality'] }),
    'utf8',
  )
  await runCli(
    'register',
    manifestPath,
    'v2',
    'versions/v2',
    '2026-09-03T00:00:00.000Z',
    '--coverage',
    'municipalities',
    '--municipalities-file',
    coveragePath,
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DataManifest
  assert.deepEqual(manifest.versions.v2.coverage, {
    scope: 'municipalities',
    municipalities: ['ExamplePrefecture/ExampleMunicipality'],
  })
})

test('switch, rollback, and prune update the manifest file', async () => {
  const { manifestPath } = await setup()
  await runCli(
    'register',
    manifestPath,
    'v2',
    'versions/v2',
    '2026-09-03T00:00:00.000Z',
  )
  await runCli('switch', manifestPath, 'v2')
  let manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DataManifest
  assert.equal(manifest.current, 'v2')
  assert.equal(manifest.previous, 'v1')
  await runCli('rollback', manifestPath)
  manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DataManifest
  assert.equal(manifest.current, 'v1')
  await runCli('prune', manifestPath)
  manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DataManifest
  assert.deepEqual(Object.keys(manifest.versions), ['v1'])
  assert.equal(manifest.previous, null)
})

test('register rejects unknown and duplicate coverage options', async () => {
  const { manifestPath } = await setup()
  await runCliFailure(
    'register',
    manifestPath,
    'v2',
    'versions/v2',
    '2026-09-03T00:00:00.000Z',
    '--covergae',
    'national',
  )
  await runCliFailure(
    'register',
    manifestPath,
    'v2',
    'versions/v2',
    '2026-09-03T00:00:00.000Z',
    '--coverage',
    'national',
    '--coverage',
    'national',
  )
})
