import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { aggregate, DEDUPE_MS, dedupeHits, HitStore, normalizeHit } from '../src/hits.js'

const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime()
const DAY = 86_400_000

test('normalizeHit drops rows without a valid name or timestamp', () => {
  assert.equal(normalizeHit({ at: NOW, name: 'Bad Name' }), undefined)
  assert.equal(normalizeHit({ at: 0, name: 'ok' }), undefined)
  assert.equal(normalizeHit(null), undefined)
  const hit = normalizeHit({ at: NOW, name: 'ok', trigger: '  spaced  ', prompt: 'x'.repeat(500) })
  assert.equal(hit.name, 'ok')
  assert.equal(hit.trigger, 'spaced')
  assert.equal(hit.prompt.length, 401)
  assert.equal(hit.via, 'tool')
})

test('the same skill in one session within the dedupe window counts once', () => {
  const hits = [
    { at: NOW, name: 'alpha', session: 's1', via: 'tool', trigger: 'alpha' },
    { at: NOW + 1000, name: 'alpha', session: 's1', via: 'gesture', trigger: '/alpha', prompt: '/alpha go' },
    { at: NOW + 1000 + DEDUPE_MS, name: 'alpha', session: 's1', via: 'tool', trigger: 'alpha' },
  ]
  const deduped = dedupeHits(hits)
  assert.equal(deduped.length, 2)
  assert.equal(deduped[0].via, 'gesture')
  assert.equal(deduped[0].trigger, '/alpha')
  assert.equal(deduped[1].via, 'tool')
})

test('aggregate separates the 7-day window from older hits', () => {
  const hits = [
    { at: NOW, name: 'alpha', session: 's1', title: 'one', trigger: '/alpha', via: 'gesture', prompt: 'go' },
    { at: NOW - DAY, name: 'alpha', session: 's2', trigger: 'alpha', via: 'tool' },
    { at: NOW - 8 * DAY, name: 'alpha', session: 's1', trigger: 'alpha', via: 'tool' },
    { at: NOW - 2 * DAY, name: 'beta', session: 's3', trigger: 'beta', via: 'tool' },
    { at: NOW, name: 'Bad Name', session: 's4' },
  ]
  const summary = aggregate(hits, { now: NOW, days: 7 })
  const alpha = summary.byName.get('alpha')
  assert.equal(alpha.hits7, 2)
  assert.equal(alpha.hitsTotal, 3)
  assert.equal(alpha.hitsOlder, 1)
  assert.equal(alpha.last.session, 's1')
  assert.equal(alpha.last.trigger, '/alpha')
  assert.equal(alpha.recent.length, 3)
  assert.equal(summary.byName.get('beta').hits7, 1)
  assert.equal(summary.byName.has('Bad Name'), false)
  assert.equal(summary.totalHits7, 3)
  assert.deepEqual(summary.sessions.sort(), ['s1', 's2', 's3'])
})

test('daily buckets put today in the last slot', () => {
  const hits = [
    { at: NOW, name: 'alpha' },
    { at: NOW - DAY, name: 'alpha' },
    { at: NOW - 3 * DAY, name: 'alpha' },
  ]
  const summary = aggregate(hits, { now: NOW, days: 7 })
  const daily = summary.byName.get('alpha').daily
  assert.deepEqual(daily, [0, 0, 0, 1, 0, 1, 1])
  assert.equal(summary.dailyLabels.length, 7)
})

test('HitStore persists, reloads and ignores a corrupt line', () => {
  const home = mkdtempSync(join(tmpdir(), 'radar-hits-'))
  const file = join(home, 'skill-radar', 'hits.jsonl')
  const store = new HitStore({ filePath: file, now: () => NOW })
  store.record({ at: NOW, name: 'alpha', session: 's1', via: 'gesture', trigger: '/alpha' })
  store.record({ at: NOW - DAY, name: 'beta', session: 's2', via: 'tool' })
  assert.equal(store.hits.length, 2)
  assert.equal(store.lastCwd(), undefined)

  const text = readFileSync(file, 'utf8')
  writeFileSync(file, 'not json at all\n' + text)
  const reloaded = new HitStore({ filePath: file, now: () => NOW })
  assert.equal(reloaded.hits.length, 2)
  assert.equal(reloaded.summary(NOW, 7).byName.get('alpha').hits7, 1)
})

test('HitStore drops rows older than the retention window', () => {
  const home = mkdtempSync(join(tmpdir(), 'radar-hits-retention-'))
  const file = join(home, 'hits.jsonl')
  const store = new HitStore({ filePath: file, now: () => NOW })
  store.record({ at: NOW - 40 * DAY, name: 'ancient', session: 's1' })
  store.record({ at: NOW - 2 * DAY, name: 'recent', session: 's2' })
  const reloaded = new HitStore({ filePath: file, now: () => NOW })
  assert.deepEqual(
    reloaded.hits.map((hit) => hit.name),
    ['recent'],
  )
})

test('HitStore.clear empties memory and the file', () => {
  const home = mkdtempSync(join(tmpdir(), 'radar-hits-clear-'))
  const file = join(home, 'hits.jsonl')
  const store = new HitStore({ filePath: file, now: () => NOW })
  store.record({ at: NOW, name: 'alpha' })
  store.clear()
  assert.equal(store.hits.length, 0)
  assert.equal(readFileSync(file, 'utf8'), '')
})

test('the 7-day count and the daily bars use the same window bounds', () => {
  const summary = aggregate(
    [
      { at: NOW - 7 * DAY - 1000, name: 'alpha', session: 'old' },
      { at: NOW + 60_000, name: 'alpha', session: 'future' },
    ],
    { now: NOW, days: 7 },
  )
  const alpha = summary.byName.get('alpha')
  assert.equal(alpha.hits7, 0)
  assert.equal(alpha.daily.reduce((sum, value) => sum + value, 0), 0)
  assert.equal(alpha.hitsOlder, 1)
  assert.equal(summary.totalHits7, 0)
})

test('HitStore rewrites the ledger when maxHits trims it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-max-'))
  const file = join(dir, 'hits.jsonl')
  const store = new HitStore({ filePath: file, max: 2, now: () => NOW })
  store.record({ at: NOW - 3000, name: 'alpha', session: 's1' })
  store.record({ at: NOW - 2000, name: 'beta', session: 's1' })
  store.record({ at: NOW - 1000, name: 'gamma', session: 's1' })

  assert.equal(store.hits.length, 2)
  const rows = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    rows.map((row) => row.name),
    ['beta', 'gamma'],
  )
})
