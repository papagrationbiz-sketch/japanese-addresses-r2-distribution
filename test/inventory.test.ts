import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { generateInventory, verifyInventory } from '../scripts/inventory.mts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'japanese-addresses-inventory-'))
  await mkdir(join(root, 'api', 'nested'), { recursive: true })
  await writeFile(join(root, 'api', 'z.json'), '{"synthetic":true}\n')
  await writeFile(join(root, 'api', 'nested', 'a.txt'), 'synthetic\n')
  return root
}

test('generates sorted deterministic inventory and detects missing, extra, and changed shards', async () => {
  const root = await fixture()
  const directory = await mkdtemp(join(tmpdir(), 'japanese-addresses-inventory-output-'))
  const first = join(directory, 'first.json')
  const second = join(directory, 'second.json')
  try {
    const generated = await generateInventory(root, first)
    await generateInventory(root, second)
    assert.equal(await readFile(first, 'utf8'), await readFile(second, 'utf8'))
    assert.equal(generated.fileCount, 2)
    assert.equal(generated.totalBytes, 29)
    await verifyInventory(root, first)

    await writeFile(join(root, 'api', 'extra.bin'), 'extra')
    await assert.rejects(verifyInventory(root, first), /inventory counts|mismatch/)
    await rm(join(root, 'api', 'extra.bin'))
    await writeFile(join(root, 'api', 'z.json'), '{"synthetiX":true}\n')
    await assert.rejects(verifyInventory(root, first), /mismatch/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects symlinks and unsafe inventory locations', async () => {
  const root = await fixture()
  const directory = await mkdtemp(join(tmpdir(), 'japanese-addresses-inventory-output-'))
  try {
    await symlink(join(root, 'api', 'z.json'), join(root, 'api', 'link.json'))
    await assert.rejects(
      generateInventory(root, join(directory, 'inventory.json')),
      /symlink is not allowed/,
    )
    await assert.rejects(
      generateInventory(root, join(directory, 'inventory.json'), '../inventory.json'),
      /inventoryPath must be safe/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})
