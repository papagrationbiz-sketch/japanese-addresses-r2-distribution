import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const cli = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
const validator = join(process.cwd(), 'scripts/validate-dataset.mts')
const prefectures = [
  '北海道',
  '青森県',
  '岩手県',
  '宮城県',
  '秋田県',
  '山形県',
  '福島県',
  '茨城県',
  '栃木県',
  '群馬県',
  '埼玉県',
  '千葉県',
  '東京都',
  '神奈川県',
  '新潟県',
  '富山県',
  '石川県',
  '福井県',
  '山梨県',
  '長野県',
  '岐阜県',
  '静岡県',
  '愛知県',
  '三重県',
  '滋賀県',
  '京都府',
  '大阪府',
  '兵庫県',
  '奈良県',
  '和歌山県',
  '鳥取県',
  '島根県',
  '岡山県',
  '広島県',
  '山口県',
  '徳島県',
  '香川県',
  '愛媛県',
  '高知県',
  '福岡県',
  '佐賀県',
  '長崎県',
  '熊本県',
  '大分県',
  '宮崎県',
  '鹿児島県',
  '沖縄県',
]
const updated = 1_750_000_000

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'japanese-addresses-dataset-'))
  const data = prefectures.map((pref) => ({ pref, cities: [{ city: 'SyntheticCity' }] }))
  await mkdir(join(root, 'ja'), { recursive: true })
  await writeFile(
    join(root, 'ja.json'),
    JSON.stringify({ meta: { updated }, data }),
    'utf8',
  )
  for (const pref of prefectures) {
    const directory = join(root, 'ja', pref)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'SyntheticCity.json'),
      JSON.stringify({
        meta: { updated },
        data: [
          {
            csv_ranges: {
              '住居表示': { start: 0, length: 1 },
              '地番': { start: 0, length: 1 },
            },
          },
        ],
      }),
      'utf8',
    )
    await writeFile(join(directory, 'SyntheticCity-住居表示.txt'), 'x')
    await writeFile(join(directory, 'SyntheticCity-地番.txt'), 'y')
  }
  return root
}

async function run(root: string): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await execFileAsync(process.execPath, [cli, validator, root], {
      cwd: process.cwd(),
    })
    return { ok: true, output: result.stdout }
  } catch (error) {
    return { ok: false, output: String((error as { stdout?: string }).stdout ?? '') }
  }
}

test('accepts a complete synthetic national dataset', async () => {
  const root = await fixture()
  try {
    const result = await run(root)
    assert.equal(result.ok, true)
    const summary = JSON.parse(result.output) as { valid: boolean; prefectureCount: number }
    assert.equal(summary.valid, true)
    assert.equal(summary.prefectureCount, 47)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('accepts a town without optional csv_ranges', async () => {
  const root = await fixture()
  try {
    const cityPath = join(root, 'ja', prefectures[0], 'SyntheticCity.json')
    const city = JSON.parse(await readFile(cityPath, 'utf8')) as { data: unknown[] }
    city.data = [{}]
    await writeFile(cityPath, JSON.stringify(city), 'utf8')
    const result = await run(root)
    assert.equal(result.ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails malformed csv_ranges instead of silently skipping it', async () => {
  const root = await fixture()
  try {
    const cityPath = join(root, 'ja', prefectures[0], 'SyntheticCity.json')
    const city = JSON.parse(await readFile(cityPath, 'utf8')) as { data: unknown[] }
    city.data = [{ csv_ranges: 'invalid' }]
    await writeFile(cityPath, JSON.stringify(city), 'utf8')
    const result = await run(root)
    assert.equal(result.ok, false)
    assert.match(result.output, /csv_ranges is malformed/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
