// Hit ledger: what fired, when, in which session, and with which trigger word.
//
// Two host events feed it:
//   tools/result    -> a model loaded a skill through the `skill` tool
//   session/event   -> a user typed `/name`, which the harness turns into an
//                      injected `skill-invocation` user message (no tool call)
//
// The ledger is append-only JSONL. Aggregation is pure so the 7-day window,
// ranking and stale-skill rule can be tested without a harness.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isSkillName } from './frontmatter.js'

export const DEFAULT_WINDOW_DAYS = 7
export const DEFAULT_RETENTION_DAYS = 30
export const DEDUPE_MS = 30_000

const DAY_MS = 86_400_000

function clampText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** Validate and clamp one ledger row. Invalid names/timestamps are dropped. */
export function normalizeHit(input) {
  if (input === null || typeof input !== 'object') return undefined
  const at = Number(input.at)
  if (!Number.isFinite(at) || at <= 0) return undefined
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!isSkillName(name)) return undefined
  const via = input.via === 'gesture' ? 'gesture' : 'tool'
  return {
    at: Math.round(at),
    name,
    session: clampText(input.session, 160),
    title: clampText(input.title, 200),
    trigger: clampText(input.trigger, 120) || (via === 'gesture' ? '/' + name : name),
    prompt: clampText(input.prompt, 400),
    via,
    cwd: clampText(input.cwd, 400),
  }
}

/**
 * Collapse the same skill firing twice in one session within a short window.
 * A user gesture and the resulting tool load are one usage, not two.
 */
export function dedupeHits(hits, windowMs = DEDUPE_MS) {
  const out = []
  for (const hit of hits) {
    const previous = out[out.length - 1]
    if (
      previous !== undefined &&
      previous.name === hit.name &&
      previous.session === hit.session &&
      Math.abs(hit.at - previous.at) <= windowMs
    ) {
      const merged = { ...previous }
      merged.at = Math.min(previous.at, hit.at)
      merged.trigger = hit.trigger || previous.trigger
      if (!merged.title && hit.title) merged.title = hit.title
      if (hit.via === 'gesture') {
        merged.via = 'gesture'
        merged.trigger = hit.trigger || '/' + hit.name
        merged.prompt = hit.prompt || previous.prompt
      } else if (!merged.prompt && hit.prompt) {
        merged.prompt = hit.prompt
      }
      out[out.length - 1] = merged
      continue
    }
    out.push({ ...hit })
  }
  return out
}

function pad(value) {
  return value < 10 ? '0' + value : String(value)
}

function startOfLocalDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dayDiff(a, b) {
  return Math.round((a - b) / DAY_MS)
}

/**
 * Aggregate ledger rows into per-skill 7-day counts, a daily sparkline, and
 * the most recent hits. Sorted recent lists keep the panel cheap to render.
 */
export function aggregate(hits, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const days = Number.isInteger(options.days) && options.days > 0 ? options.days : DEFAULT_WINDOW_DAYS
  const recentLimit = Number.isInteger(options.recentLimit) && options.recentLimit > 0 ? options.recentLimit : 6
  const cutoff = now - days * DAY_MS
  const today = startOfLocalDay(now)

  const dailyLabels = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)
    dailyLabels.push(pad(date.getMonth() + 1) + '-' + pad(date.getDate()))
  }

  const byName = new Map()
  const sessions = new Set()
  let totalHits7 = 0

  for (const raw of hits) {
    const hit = normalizeHit(raw)
    if (hit === undefined) continue
    let entry = byName.get(hit.name)
    if (entry === undefined) {
      entry = {
        name: hit.name,
        hits7: 0,
        hitsTotal: 0,
        hitsOlder: 0,
        daily: new Array(days).fill(0),
        recent: [],
        last: null,
      }
      byName.set(hit.name, entry)
    }
    entry.hitsTotal += 1
    if (entry.last === null || hit.at >= entry.last.at) entry.last = hit
    entry.recent.push(hit)

    const index = days - 1 - dayDiff(today, startOfLocalDay(hit.at))
    const inWindow = hit.at <= now && hit.at >= cutoff && index >= 0 && index < days
    if (inWindow) {
      entry.hits7 += 1
      totalHits7 += 1
      if (hit.session.length > 0) sessions.add(hit.session)
      entry.daily[index] += 1
    } else if (hit.at < cutoff) {
      entry.hitsOlder += 1
    }
  }

  for (const entry of byName.values()) {
    entry.recent.sort((a, b) => b.at - a.at)
    entry.recent = entry.recent.slice(0, recentLimit)
  }

  return {
    now,
    days,
    cutoff,
    dailyLabels,
    byName,
    totalHits7,
    sessions: Array.from(sessions),
  }
}

/** Append-only JSONL ledger with an in-memory, deduped view. */
export class HitStore {
  constructor(options = {}) {
    this.file = typeof options.filePath === 'string' ? options.filePath : ''
    this.max = Number.isInteger(options.max) && options.max > 0 ? options.max : 5000
    this.retentionDays =
      Number.isInteger(options.retentionDays) && options.retentionDays > 0
        ? options.retentionDays
        : DEFAULT_RETENTION_DAYS
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.hits = []
    this.load()
  }

  load() {
    let text = ''
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      this.hits = []
      return
    }
    const parsed = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const hit = normalizeHit(JSON.parse(trimmed))
        if (hit !== undefined) parsed.push(hit)
      } catch (error) {
        // A truncated line from a crash must not hide the rest of the ledger.
      }
    }
    parsed.sort((a, b) => a.at - b.at)
    const cutoff = this.now() - this.retentionDays * DAY_MS
    const kept = parsed.filter((hit) => hit.at >= cutoff)
    this.hits = dedupeHits(kept).slice(-this.max)
    if (parsed.length !== this.hits.length) this.rewrite()
  }

  /** Replace the append-only file with the compacted view after a trim. */
  rewrite() {
    if (this.file.length === 0) return
    const tmp = this.file + '.radar-' + process.pid + '-' + Date.now()
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const body = this.hits.map((hit) => JSON.stringify(hit)).join('\n')
      writeFileSync(tmp, body.length > 0 ? body + '\n' : '')
      renameSync(tmp, this.file)
    } catch (error) {
      // Keeping the in-memory view is still better than failing a hit.
    }
  }

  record(input) {
    const hit = normalizeHit({
      ...input,
      at: input !== null && typeof input === 'object' && input.at !== undefined ? input.at : this.now(),
    })
    if (hit === undefined) return undefined

    const previous = this.hits[this.hits.length - 1]
    this.hits.push(hit)
    if (
      previous !== undefined &&
      previous.name === hit.name &&
      previous.session === hit.session &&
      Math.abs(hit.at - previous.at) <= DEDUPE_MS
    ) {
      const merged = dedupeHits([previous, hit])[0]
      this.hits.splice(this.hits.length - 2, 2, merged)
    }
    if (this.hits.length > this.max) {
      this.hits.splice(0, this.hits.length - this.max)
      this.rewrite()
      return hit
    }
    this.persist(hit)
    return hit
  }

  persist(hit) {
    if (this.file.length === 0) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, JSON.stringify(hit) + '\n')
    } catch (error) {
      // An unwritable ledger must never affect a tool call or the panel's reads.
    }
  }

  summary(now = this.now(), days = DEFAULT_WINDOW_DAYS) {
    return aggregate(this.hits, { now, days })
  }

  lastCwd() {
    for (let index = this.hits.length - 1; index >= 0; index -= 1) {
      const cwd = this.hits[index].cwd
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    }
    return undefined
  }

  recent(limit) {
    return this.hits.slice(-limit).reverse()
  }

  clear() {
    this.hits = []
    if (this.file.length === 0) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, '')
    } catch (error) {
      // Keep the in-memory clear even when the file cannot be truncated.
    }
  }
}
