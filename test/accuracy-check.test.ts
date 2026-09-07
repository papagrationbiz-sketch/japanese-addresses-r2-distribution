import assert from 'node:assert/strict'
import test from 'node:test'
import {
  gsiLookup,
  haversineMeters,
  pickIndex,
  runAccuracyCheck,
  selectCases,
  summarize,
  townLabel,
  type AccuracyFetch,
  type AccuracyResult,
} from '../scripts/accuracy-check.mts'

const BASE = 'https://addr.example.com'
const VERSION = 'v-test'
const PREFIX = `${BASE}/versions/${VERSION}/api`

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Two prefectures; 岩手県/A市 has no town JSON, so the sample must fall through. */
function stubFetch(calls: string[] = []): AccuracyFetch {
  const towns = {
    '青森県/青森市': [
      { oaza_cho: '長島', chome: '一丁目', point: [140.74, 40.82] },
      { oaza_cho: '本町', point: [140.75, 40.83] },
    ],
    '岩手県/B市': [{ oaza_cho: '内丸', point: [141.15, 39.7] }],
    '北海道/札幌市中央区': [{ oaza_cho: '北一条西', point: [141.35, 43.06] }],
    '沖縄県/石垣市': [{ oaza_cho: '美崎町', point: [124.15, 24.33] }],
    '東京都/八丈町': [{ oaza_cho: '大賀郷', point: [139.76, 33.12] }],
  } as Record<string, unknown[]>

  return async (input) => {
    calls.push(input)
    const url = new URL(input)
    if (url.origin === 'https://msearch.gsi.go.jp') {
      return jsonResponse([{ geometry: { coordinates: [140.7401, 40.8201] } }])
    }
    const path = decodeURIComponent(url.pathname)
    if (path.endsWith('/api/ja.json')) {
      return jsonResponse({ data: [{ pref: '青森県' }, { pref: '岩手県' }] })
    }
    if (path.endsWith('/api/ja/青森県.json')) return jsonResponse({ data: [{ city: '青森市' }] })
    if (path.endsWith('/api/ja/岩手県.json')) {
      return jsonResponse({ data: [{ city: 'A市' }, { city: 'B市' }] })
    }
    const key = path.replace(/^.*\/api\/ja\//, '').replace(/\.json$/, '')
    const data = towns[key]
    if (!data) return new Response('not found', { status: 404 })
    return jsonResponse({ data })
  }
}

test('pickIndex is deterministic and stays in range', () => {
  assert.equal(pickIndex('青森県#0', 10), pickIndex('青森県#0', 10))
  assert.notEqual(pickIndex('青森県#0', 10), pickIndex('青森県#1', 10))
  for (const seed of ['a', 'bb', '東京都/新宿区#3']) {
    const index = pickIndex(seed, 7)
    assert.ok(Number.isInteger(index) && index >= 0 && index < 7)
  }
  assert.throws(() => pickIndex('a', 0))
})

test('townLabel concatenates the town name parts that are present', () => {
  assert.equal(townLabel({ oaza_cho: '長島', chome: '一丁目' }), '長島一丁目')
  assert.equal(townLabel({ oaza_cho: '本町' }), '本町')
  assert.equal(townLabel({}), '')
})

test('haversineMeters measures known distances', () => {
  assert.equal(Math.round(haversineMeters([139.7, 35.7], [139.7, 35.7])), 0)
  // One degree of latitude is close to 111 km.
  assert.ok(Math.abs(haversineMeters([139.7, 35.0], [139.7, 36.0]) - 111195) < 200)
  // The recorded 八丈町 pair sits well under a metre apart.
  assert.ok(haversineMeters([139.766238, 33.120906], [139.766235, 33.120907]) < 1)
})

test('selectCases samples one case per prefecture and skips municipalities without towns', async () => {
  const cases = await selectCases(stubFetch(), PREFIX)
  const prefs = cases.map((one) => one.pref)
  assert.ok(prefs.includes('青森県'))
  assert.ok(prefs.includes('岩手県'))
  // 岩手県 must fall through A市 (no town JSON) to B市.
  const iwate = cases.find((one) => one.pref === '岩手県')!
  assert.equal(iwate.city, 'B市')
  assert.equal(iwate.query, '岩手県B市内丸')
  // The fixed structural cases are appended, including the ward form.
  const sapporo = cases.find((one) => one.query.startsWith('北海道札幌市中央区'))!
  assert.equal(sapporo.ward, '中央区')
  assert.deepEqual(sapporo.abr, [141.35, 43.06])
  assert.equal(cases.length, new Set(cases.map((one) => one.query)).size)
})

test('selectCases is stable across runs', async () => {
  const first = await selectCases(stubFetch(), PREFIX)
  const second = await selectCases(stubFetch(), PREFIX)
  assert.deepEqual(
    first.map((one) => one.query),
    second.map((one) => one.query),
  )
})

test('gsiLookup returns null when the search has no usable hit', async () => {
  const empty: AccuracyFetch = async () => jsonResponse([])
  assert.equal(await gsiLookup(empty, '東京都八丈町大賀郷'), null)
})

test('gsiLookup throws after exhausting attempts', async () => {
  let calls = 0
  const failing: AccuracyFetch = async () => {
    calls += 1
    return new Response('busy', { status: 503 })
  }
  await assert.rejects(() => gsiLookup(failing, '東京都新宿区', 2), /GSI 503/)
  assert.equal(calls, 2)
})

test('summarize reports quantiles and unresolved cases', () => {
  const results: AccuracyResult[] = [
    { query: 'a', pref: 'p', abr: [0, 0], gsi: [0, 0], distanceMeters: 0 },
    { query: 'b', pref: 'p', abr: [0, 0], gsi: [0, 0], distanceMeters: 1 },
    { query: 'c', pref: 'p', abr: [0, 0], gsi: [0, 0], distanceMeters: 435 },
    { query: 'd', pref: 'p', abr: [0, 0], gsi: [0, 0], distanceMeters: 9000 },
    { query: 'e', pref: 'p', abr: [0, 0], gsi: null, distanceMeters: null },
  ]
  const summary = summarize(BASE, VERSION, results)
  assert.equal(summary.caseCount, 5)
  assert.equal(summary.gsiResolved, 4)
  assert.equal(summary.gsiUnresolved, 1)
  assert.equal(summary.distanceMeters.min, 0)
  assert.equal(summary.distanceMeters.max, 9000)
  assert.equal(summary.within500m, 3)
  assert.equal(summary.within1000m, 3)
  assert.equal(summary.over5000m, 1)
})

test('summarize handles a run where nothing resolved', () => {
  const summary = summarize(BASE, VERSION, [
    { query: 'a', pref: 'p', abr: [0, 0], gsi: null, distanceMeters: null },
  ])
  assert.deepEqual(summary.distanceMeters, { min: null, median: null, p90: null, max: null })
})

test('runAccuracyCheck rejects an unusable base URL or version', async () => {
  await assert.rejects(
    () => runAccuracyCheck({ base: 'ftp://addr.example.com', version: VERSION, delayMs: 0 }),
    /HTTP or HTTPS/,
  )
  await assert.rejects(
    () => runAccuracyCheck({ base: `${BASE}/sub`, version: VERSION, delayMs: 0 }),
    /must not contain/,
  )
  await assert.rejects(
    () => runAccuracyCheck({ base: BASE, version: 'bad version', delayMs: 0 }),
    /invalid version/,
  )
})

test('runAccuracyCheck records a distance per case', async () => {
  const report = await runAccuracyCheck({
    base: BASE,
    version: VERSION,
    fetchImpl: stubFetch(),
    delayMs: 0,
  })
  assert.equal(report.summary.caseCount, report.results.length)
  assert.ok(report.results.every((one) => typeof one.distanceMeters === 'number'))
  const aomori = report.results.find((one) => one.pref === '青森県')!
  // The stub always answers with the same point, so the distance is the
  // haversine between that point and whichever town was sampled.
  assert.deepEqual(aomori.gsi, [140.7401, 40.8201])
  assert.equal(aomori.distanceMeters, Math.round(haversineMeters(aomori.abr, [140.7401, 40.8201])))
})
