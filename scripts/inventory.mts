import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

export type InventoryEntry = {
  path: string
  size: number
  sha256: string
}

export type Sha256Inventory = {
  schemaVersion: 1
  algorithm: 'sha256'
  fileCount: number
  totalBytes: number
  files: InventoryEntry[]
}

const SHA256 = /^[0-9a-f]{64}$/

function safeRelativePath(value: string): boolean {
  const parts = value.split('/')
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('//') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !parts.some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        [...part].some((character) => character.charCodeAt(0) < 0x20),
    )
  )
}

function relativePOSIX(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/')
  if (!safeRelativePath(value)) throw new Error(`unsafe inventory path: ${value}`)
  return value
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function collectFiles(root: string, inventoryPath: string): Promise<InventoryEntry[]> {
  const apiRoot = join(root, 'api')
  const apiInfo = await lstat(apiRoot)
  if (!apiInfo.isDirectory() || apiInfo.isSymbolicLink()) {
    throw new Error('version root must contain a real api directory')
  }

  const entries: InventoryEntry[] = []
  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const path = join(directory, child.name)
      const relativePath = relativePOSIX(root, path)
      if (relativePath === inventoryPath) continue
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`symlink is not allowed: ${relativePath}`)
      if (info.isDirectory()) {
        await visit(path)
      } else if (info.isFile()) {
        entries.push({
          path: relativePath,
          size: info.size,
          sha256: await sha256File(path),
        })
      } else {
        throw new Error(`non-regular file is not allowed: ${relativePath}`)
      }
    }
  }
  await visit(apiRoot)
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  if (entries.length === 0) throw new Error('version root contains no api files')
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0)
  if (!Number.isSafeInteger(totalBytes)) throw new Error('inventory totalBytes is unsafe')
  return entries
}

function inventoryJSON(files: InventoryEntry[]): string {
  const inventory: Sha256Inventory = {
    schemaVersion: 1,
    algorithm: 'sha256',
    fileCount: files.length,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
    files,
  }
  return `${JSON.stringify(inventory, null, 2)}\n`
}

function validateInventory(value: unknown): Sha256Inventory {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    (value as { algorithm?: unknown }).algorithm !== 'sha256'
  ) {
    throw new Error('inventory schema must be version 1 sha256')
  }
  const raw = value as Partial<Sha256Inventory>
  const fileCount = raw.fileCount
  const totalBytes = raw.totalBytes
  if (
    typeof fileCount !== 'number' ||
    !Number.isSafeInteger(fileCount) ||
    fileCount <= 0 ||
    typeof totalBytes !== 'number' ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    !Array.isArray(raw.files) ||
    raw.files.length !== fileCount
  ) {
    throw new Error('inventory counts are invalid')
  }
  const files = raw.files.map((entry, index) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.path !== 'string' ||
      !safeRelativePath(entry.path) ||
      !entry.path.startsWith('api/') ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== 'string' ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error(`inventory entry ${index} is invalid`)
    }
    return { path: entry.path, size: entry.size, sha256: entry.sha256 }
  })
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1].path >= files[index].path) {
      throw new Error('inventory paths must be sorted and unique')
    }
  }
  const computedTotalBytes = files.reduce((total, entry) => total + entry.size, 0)
  if (computedTotalBytes !== totalBytes) throw new Error('inventory totalBytes does not match files')
  return {
    schemaVersion: 1,
    algorithm: 'sha256',
    fileCount,
    totalBytes,
    files,
  }
}

export async function generateInventory(
  root: string,
  output: string,
  inventoryPath = '_integrity/sha256.json',
): Promise<Sha256Inventory> {
  if (
    !safeRelativePath(inventoryPath) ||
    inventoryPath === 'api' ||
    inventoryPath.startsWith('api/')
  ) {
    throw new Error('inventoryPath must be safe and outside api/')
  }
  const files = await collectFiles(root, inventoryPath)
  const contents = inventoryJSON(files)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, contents, 'utf8')
  return validateInventory(JSON.parse(contents))
}

export async function verifyInventory(
  root: string,
  inventoryFile: string,
  inventoryPath = '_integrity/sha256.json',
): Promise<Sha256Inventory> {
  if (
    !safeRelativePath(inventoryPath) ||
    inventoryPath === 'api' ||
    inventoryPath.startsWith('api/')
  ) {
    throw new Error('inventoryPath must be safe and outside api/')
  }
  const expected = validateInventory(JSON.parse(await readFile(inventoryFile, 'utf8')))
  const actualFiles = await collectFiles(root, inventoryPath)
  const actual = validateInventory({
    schemaVersion: 1,
    algorithm: 'sha256',
    fileCount: actualFiles.length,
    totalBytes: actualFiles.reduce((total, entry) => total + entry.size, 0),
    files: actualFiles,
  })
  if (actual.fileCount !== expected.fileCount || actual.totalBytes !== expected.totalBytes) {
    throw new Error('inventory counts do not match')
  }
  for (let index = 0; index < expected.files.length; index += 1) {
    const left = expected.files[index]
    const right = actual.files[index]
    if (
      !right ||
      left.path !== right.path ||
      left.size !== right.size ||
      left.sha256 !== right.sha256
    ) {
      throw new Error(`inventory mismatch at ${left.path}`)
    }
  }
  return expected
}

function usage(): never {
  throw new Error(
    'Usage: inventory <generate|verify> <version-root> <inventory-file> [inventory-path]',
  )
}

if (process.argv[1]?.endsWith('/inventory.mts')) {
  const [command, root, output, inventoryPath = '_integrity/sha256.json'] = process.argv.slice(2)
  if (!command || !root || !output || !['generate', 'verify'].includes(command)) usage()
  if (command === 'generate') await generateInventory(root, output, inventoryPath)
  else await verifyInventory(root, output, inventoryPath)
  console.log(JSON.stringify({ ok: true, command, inventoryPath }))
}
