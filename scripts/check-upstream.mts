import { appendFile, readFile } from 'node:fs/promises'

type State = {
  repository: string
  ref: string
  commit: string
  dataUpdatedUnix: number
}

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : fallback
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

function assertRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('--repo must be an owner/name pair')
  }
}

function assertRef(ref: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) ||
    ref.includes('..') ||
    ref.endsWith('/')
  ) {
    throw new Error('--ref is invalid')
  }
}

function assertDataApi(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('--data-api must be an HTTPS URL without credentials or a fragment')
  }
}

async function fetchJson(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

const statePath = arg('--state', 'docs/upstream-state.json')
const state = JSON.parse(await readFile(statePath, 'utf8')) as State
if (!state || typeof state !== 'object') throw new Error('upstream state must be an object')

const repo = arg('--repo', state.repository)
const ref = arg('--ref', state.ref)
const dataApi = arg('--data-api', 'https://japanese-addresses-v2.geoloniamaps.com/api/ja.json')
assertRepository(repo)
assertRef(ref)
assertDataApi(dataApi)
if (!/^[0-9a-f]{40}$/.test(state.commit) || !Number.isSafeInteger(state.dataUpdatedUnix) || state.dataUpdatedUnix <= 0) {
  throw new Error('upstream state has invalid baseline values')
}

const [commitRaw, dataRaw] = await Promise.all([
  fetchJson(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, process.env.GITHUB_TOKEN),
  fetchJson(dataApi),
])
const commit = (commitRaw as { sha?: unknown }).sha
const updated = (dataRaw as { meta?: { updated?: unknown } }).meta?.updated
if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('upstream commit SHA is invalid')
if (!Number.isSafeInteger(updated) || Number(updated) <= 0) throw new Error('upstream meta.updated is invalid')

const commitChanged = commit !== state.commit
const dataChanged = Number(updated) !== state.dataUpdatedUnix
const result = {
  changed: commitChanged || dataChanged,
  commitChanged,
  dataChanged,
  previousCommit: state.commit,
  currentCommit: commit,
  previousDataUpdatedUnix: state.dataUpdatedUnix,
  currentDataUpdatedUnix: Number(updated),
  currentDataUpdatedAt: new Date(Number(updated) * 1000).toISOString(),
}
console.log(JSON.stringify(result))

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, [
    `changed=${result.changed}`,
    `commit_changed=${commitChanged}`,
    `data_changed=${dataChanged}`,
    `current_commit=${commit}`,
    `current_data_updated_unix=${updated}`,
    `current_data_updated_at=${result.currentDataUpdatedAt}`,
    '',
  ].join('\n'))
}
