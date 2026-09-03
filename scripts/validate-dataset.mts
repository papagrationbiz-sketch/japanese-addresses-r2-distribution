import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

type JsonRecord = Record<string, unknown>

const root = process.argv[2] || 'out/api'
const errors: string[] = []
const fail = (message: string): void => {
  if (errors.length < 50) errors.push(message)
}
const record = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const safeComponent = (value: string): boolean =>
  value.length > 0 &&
  !value.includes('/') &&
  !value.includes('\\') &&
  !value.includes('..') &&
  !value.includes('\0') &&
  [...value].every((character) => character.charCodeAt(0) >= 0x20)

const expectedPrefectures = new Set([
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
])

async function readJson(path: string): Promise<JsonRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!record(value)) throw new Error('root is not an object')
    return value
  } catch (error) {
    fail(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

const rootJson = await readJson(join(root, 'ja.json'))
if (!rootJson) throw new Error(JSON.stringify({ valid: false, errors }))

const updated = record(rootJson.meta) ? rootJson.meta.updated : undefined
if (!Number.isSafeInteger(updated) || Number(updated) <= 0) {
  fail('ja.json: invalid meta.updated')
}

const prefectures = Array.isArray(rootJson.data) ? rootJson.data : []
if (prefectures.length !== 47) fail(`expected 47 prefectures, got ${prefectures.length}`)

const seenPrefectures = new Set<string>()
const seenMunicipalities = new Set<string>()
let municipalityCount = 0
let townCount = 0
let rangeCount = 0
let rangeBytes = 0
const checkedFiles = new Map<string, number>()

for (const rawPrefecture of prefectures) {
  if (!record(rawPrefecture) || typeof rawPrefecture.pref !== 'string' || !Array.isArray(rawPrefecture.cities)) {
    fail('invalid prefecture entry')
    continue
  }
  if (!safeComponent(rawPrefecture.pref)) {
    fail(`unsafe prefecture name: ${rawPrefecture.pref}`)
    continue
  }
  if (!expectedPrefectures.has(rawPrefecture.pref)) {
    fail(`unexpected prefecture: ${rawPrefecture.pref}`)
  }
  if (seenPrefectures.has(rawPrefecture.pref)) fail(`duplicate prefecture: ${rawPrefecture.pref}`)
  seenPrefectures.add(rawPrefecture.pref)

  for (const rawCity of rawPrefecture.cities) {
    if (!record(rawCity)) {
      fail(`${rawPrefecture.pref}: invalid city entry`)
      continue
    }
    const city = [rawCity.county, rawCity.city, rawCity.ward]
      .filter((part): part is string => typeof part === 'string')
      .join('')
    if (!safeComponent(city)) {
      fail(`${rawPrefecture.pref}: unsafe municipality name`)
      continue
    }
    const municipalityKey = `${rawPrefecture.pref}/${city}`
    if (seenMunicipalities.has(municipalityKey)) {
      fail(`duplicate municipality: ${municipalityKey}`)
      continue
    }
    seenMunicipalities.add(municipalityKey)
    municipalityCount += 1

    const cityPath = join(root, 'ja', rawPrefecture.pref, `${city}.json`)
    const cityJson = await readJson(cityPath)
    if (!cityJson) continue
    if (
      !record(cityJson.meta) ||
      !Number.isSafeInteger(cityJson.meta.updated) ||
      Number(cityJson.meta.updated) <= 0
    ) {
      fail(`${cityPath}: invalid or missing meta.updated`)
    } else if (updated !== undefined && cityJson.meta.updated !== updated) {
      fail(`${cityPath}: meta.updated mismatch`)
    }
    if (!Array.isArray(cityJson.data)) {
      fail(`${cityPath}: data must be an array`)
      continue
    }
    const towns = Array.isArray(cityJson.data) ? cityJson.data : []
    townCount += towns.length

    for (const rawTown of towns) {
      if (!record(rawTown)) {
        fail(`${cityPath}: malformed town entry`)
        continue
      }
      if (rawTown.csv_ranges === undefined || rawTown.csv_ranges === null) {
        continue
      }
      if (!record(rawTown.csv_ranges)) {
        fail(`${cityPath}: town csv_ranges is malformed`)
        continue
      }
      for (const kind of ['住居表示', '地番'] as const) {
        const rawRange = rawTown.csv_ranges[kind]
        if (rawRange === undefined || rawRange === null) continue
        if (!record(rawRange)) {
          fail(`${cityPath}: malformed ${kind} range`)
          continue
        }
        const start = rawRange.start
        const length = rawRange.length
        if (
          !Number.isSafeInteger(start) ||
          Number(start) < 0 ||
          !Number.isSafeInteger(length) ||
          Number(length) <= 0
        ) {
          fail(`${cityPath}: invalid ${kind} range`)
          continue
        }

        const txtPath = join(root, 'ja', rawPrefecture.pref, `${city}-${kind}.txt`)
        let size = checkedFiles.get(txtPath)
        if (size === undefined) {
          try {
            size = (await stat(txtPath)).size
            checkedFiles.set(txtPath, size)
          } catch {
            fail(`${txtPath}: missing`)
            continue
          }
        }
        const end = Number(start) + Number(length)
        if (!Number.isSafeInteger(end)) {
          fail(`${cityPath}: range end is not a safe integer`)
        } else if (end > size) {
          fail(`${txtPath}: range exceeds object size`)
        }
        rangeCount += 1
        rangeBytes += Number(length)
      }
    }
  }
}

if (municipalityCount === 0) fail('dataset has no municipalities')
if (rangeCount === 0) fail('dataset has no address ranges')
if (checkedFiles.size === 0) fail('dataset has no text shard files')
if (seenPrefectures.size !== expectedPrefectures.size) {
  for (const prefecture of expectedPrefectures) {
    if (!seenPrefectures.has(prefecture)) fail(`missing prefecture: ${prefecture}`)
  }
}

const result = {
  valid: errors.length === 0,
  updated,
  prefectureCount: prefectures.length,
  municipalityCount,
  townCount,
  rangeCount,
  rangeBytes,
  txtFileCount: checkedFiles.size,
  errors,
}
console.log(JSON.stringify(result))
if (errors.length) process.exitCode = 1
