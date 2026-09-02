import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANIFEST_KEY,
  parseManifest,
  pruneRetiredVersions,
  registerVersion,
  rollbackVersion,
  switchVersion,
  versionPrefix,
  type DataManifest,
  type DataVersion,
} from '../src/manifest'

const usage = `Usage:
  npm run manifest -- validate <manifest-file>
  npm run manifest -- register <manifest-file> <version> <prefix> <source-updated-at> [--coverage national]
  npm run manifest -- register <manifest-file> <version> <prefix> <source-updated-at> [--coverage municipalities --municipalities-file <file>]
  npm run manifest -- switch <manifest-file> <version>
  npm run manifest -- rollback <manifest-file>
  npm run manifest -- prune <manifest-file>
  npm run manifest -- remote-switch <bucket> <version>
  npm run manifest -- remote-rollback <bucket>`

const BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/

async function readManifest(path: string): Promise<DataManifest> {
  return parseManifest(JSON.parse(await readFile(path, 'utf8')))
}

async function writeManifest(path: string, manifest: DataManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function validateBucket(bucket: string): void {
  if (!BUCKET_NAME.test(bucket)) throw new Error('bucket must be a valid R2 bucket name')
}

function wrangler(args: string[]): void {
  const result = spawnSync('npx', ['wrangler', ...args], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`wrangler exited with status ${result.status}`)
}

function download(bucket: string, key: string, destination: string): void {
  wrangler(['r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--file', destination])
}

function uploadManifest(bucket: string, source: string): void {
  wrangler([
    'r2',
    'object',
    'put',
    `${bucket}/${MANIFEST_KEY}`,
    '--remote',
    '--file',
    source,
    '--content-type',
    'application/json',
    '--cache-control',
    'no-cache',
    '--force',
  ])
}

async function remoteUpdate(
  bucket: string,
  update: (manifest: DataManifest) => DataManifest,
): Promise<DataManifest> {
  validateBucket(bucket)
  const directory = await mkdtemp(join(tmpdir(), 'japanese-addresses-manifest-'))
  const manifestPath = join(directory, MANIFEST_KEY)
  const probePath = join(directory, 'ja.json')
  try {
    download(bucket, MANIFEST_KEY, manifestPath)
    const next = update(await readManifest(manifestPath))
    // Verify the target exists before changing the public pointer.
    download(bucket, `${versionPrefix(next)}/api/ja.json`, probePath)
    await writeManifest(manifestPath, next)
    uploadManifest(bucket, manifestPath)
    return next
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function optionValue(options: string[], name: string): string | undefined {
  const index = options.indexOf(name)
  if (index < 0) return undefined
  const value = options[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function validateOptions(options: string[]): void {
  const seen = new Set<string>()
  for (let index = 0; index < options.length; index += 1) {
    const name = options[index]
    if (name !== '--coverage' && name !== '--municipalities-file') {
      throw new Error(`unknown option: ${name}`)
    }
    if (seen.has(name)) throw new Error(`duplicate option: ${name}`)
    seen.add(name)
    if (index + 1 >= options.length || options[index + 1].startsWith('--')) {
      throw new Error(`${name} requires a value`)
    }
    index += 1
  }
}

async function parseCoverage(options: string[]): Promise<DataVersion['coverage']> {
  validateOptions(options)
  const coverage = optionValue(options, '--coverage')
  const municipalitiesFile = optionValue(options, '--municipalities-file')
  if (!coverage && municipalitiesFile) {
    throw new Error('--municipalities-file requires --coverage municipalities')
  }
  if (!coverage) return undefined
  if (coverage === 'national') {
    if (municipalitiesFile) throw new Error('--municipalities-file cannot be used with national coverage')
    return { scope: 'national' }
  }
  if (coverage !== 'municipalities' || !municipalitiesFile) {
    throw new Error('--coverage must be national or municipalities with --municipalities-file')
  }

  const raw = JSON.parse(await readFile(municipalitiesFile, 'utf8')) as unknown
  const municipalities = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && 'municipalities' in raw
      ? (raw as { municipalities?: unknown }).municipalities
      : undefined
  if (!Array.isArray(municipalities)) {
    throw new Error('municipalities file must contain a JSON array or {"municipalities":[]}')
  }
  return { scope: 'municipalities', municipalities: municipalities as string[] }
}

const args = process.argv.slice(2)
const [command, first, second, third, fourth] = args
if (!command || !first) throw new Error(usage)

let result: DataManifest
switch (command) {
  case 'validate':
    result = await readManifest(first)
    break
  case 'register': {
    if (!second || !third || !fourth) throw new Error(usage)
    const coverage = await parseCoverage(args.slice(5))
    result = registerVersion(
      await readManifest(first),
      second,
      {
        prefix: third,
        publishedAt: new Date().toISOString(),
        sourceUpdatedAt: fourth,
        ...(coverage ? { coverage } : {}),
      },
    )
    await writeManifest(first, result)
    break
  }
  case 'switch':
    if (!second) throw new Error(usage)
    result = switchVersion(await readManifest(first), second)
    await writeManifest(first, result)
    break
  case 'rollback':
    result = rollbackVersion(await readManifest(first))
    await writeManifest(first, result)
    break
  case 'prune':
    result = pruneRetiredVersions(await readManifest(first))
    await writeManifest(first, result)
    break
  case 'remote-switch':
    if (!second) throw new Error(usage)
    result = await remoteUpdate(first, (manifest) => switchVersion(manifest, second))
    break
  case 'remote-rollback':
    result = await remoteUpdate(first, rollbackVersion)
    break
  default:
    throw new Error(usage)
}

console.log(JSON.stringify({ current: result.current, previous: result.previous, updatedAt: result.updatedAt }))
