// Filesystem side of the radar: discover skills exactly where the official
// `dsh-skill-filesystem` provider looks, then mutate them with the same
// conventions the Skill Center uses — frontmatter toggles and a recoverable
// per-root `.trash` recycle bin.
//
// The web profile mounts `skill-filesystem` inside each agent preset's scope,
// so a host-plane panel cannot rely on `ctx.skills.list()` for project/user
// skills. Scanning the documented roots is the primary source; the registry is
// merged in afterwards for bundled/runtime entries that have no local file.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { frontmatterBoolean, isSkillName, parseFrontmatter, renderSkillDocument, setModelInvocable } from './frontmatter.js'

export const SOURCE_META = {
  'project-dsh': { label: '项目 · .dsh/skills', short: '项目', group: '项目技能', order: 1, rank: 100 },
  'project-agents': { label: '项目 · .agents/skills', short: '项目', group: '项目技能', order: 2, rank: 200 },
  custom: { label: '自定义目录', short: '自定义', group: '自定义目录', order: 3, rank: 300 },
  'user-dsh': { label: '用户 · .dsh/skills', short: '用户', group: '用户技能', order: 4, rank: 400 },
  'user-agents': { label: '用户 · .agents/skills', short: '用户', group: '用户技能', order: 5, rank: 500 },
  bundled: { label: '系统内置', short: '内置', group: '系统与运行时', order: 6, rank: 600 },
  runtime: { label: '运行时注册', short: '运行时', group: '系统与运行时', order: 7, rank: 250 },
}

const MAX_CONTENT = 64 * 1024
const MAX_DESCRIPTION = 500

function metaOf(source) {
  return SOURCE_META[source] || SOURCE_META.runtime
}

function normalizeInline(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/** Walk up to the nearest repository root, mirroring the provider's project scoping. */
export function findProjectRoot(cwd) {
  let current = resolve(typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd())
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd())
}

/** The roots the official filesystem provider scans, in precedence order. */
export function resolveRoots(options) {
  const roots = []
  const add = (path, source) => {
    roots.push({
      path: resolve(path),
      source,
      label: metaOf(source).label,
      writable: source !== 'bundled' && source !== 'runtime',
    })
  }

  const projectRoot = findProjectRoot(options.cwd)
  add(join(projectRoot, '.dsh', 'skills'), 'project-dsh')
  add(join(projectRoot, '.agents', 'skills'), 'project-agents')

  const custom = Array.isArray(options.customSkillDirs) ? options.customSkillDirs : []
  for (const dir of custom) {
    if (typeof dir === 'string' && dir.trim().length > 0) add(dir, 'custom')
  }

  add(join(options.dshHome, 'skills'), 'user-dsh')
  add(join(options.agentsHome, 'skills'), 'user-agents')
  return roots
}

function candidateFromFile(root, skillPath, directory, link) {
  let raw
  try {
    raw = readFileSync(skillPath, 'utf8')
  } catch (error) {
    return undefined
  }
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) return undefined
  const name = normalizeInline(parsed.data.name)
  const description = normalizeInline(parsed.data.description)
  if (!isSkillName(name) || description.length === 0) return undefined
  const whenToUse =
    normalizeInline(parsed.data.whenToUse) || normalizeInline(parsed.data['when-to-use'])
  const meta = metaOf(root.source)
  return {
    name,
    description,
    whenToUse,
    source: root.source,
    sourceLabel: meta.label,
    sourceShort: meta.short,
    group: meta.group,
    groupOrder: meta.order,
    rank: meta.rank,
    provider: 'filesystem',
    path: skillPath,
    directory,
    rootPath: root.path,
    readOnly: false,
    link,
    modelInvocable: frontmatterBoolean(parsed.data, 'disable-model-invocation') !== true,
    userInvocable: frontmatterBoolean(parsed.data, 'user-invocable') !== false,
    chars: raw.length,
  }
}

/**
 * Scan every root, keep one winner per skill name using the official source
 * ranks, and count the shadowed duplicates.
 */
export function scanRoots(roots) {
  const winners = new Map()
  let shadowed = 0

  for (const root of roots) {
    let entries
    try {
      entries = readdirSync(root.path, { withFileTypes: true })
    } catch (error) {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (root.source === 'user-dsh' && entry.name === '.system') continue

      const full = join(root.path, entry.name)
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      const link = entry.isSymbolicLink()
      if (link) {
        try {
          const stat = statSync(full)
          isDirectory = stat.isDirectory()
          isFile = stat.isFile()
        } catch (error) {
          continue
        }
      }

      let skillPath
      let directory
      if (isDirectory) {
        skillPath = join(full, 'SKILL.md')
        directory = full
      } else if (isFile && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
        skillPath = full
        directory = root.path
      } else {
        continue
      }

      const candidate = candidateFromFile(root, skillPath, directory, link)
      if (candidate === undefined) continue

      const existing = winners.get(candidate.name)
      if (existing === undefined) {
        winners.set(candidate.name, candidate)
        continue
      }
      shadowed += 1
      if (candidate.rank < existing.rank) winners.set(candidate.name, candidate)
    }
  }

  return { skills: Array.from(winners.values()), shadowed }
}

/**
 * Merge registry-only rows (bundled, runtime, provider-owned) as read-only
 * entries. Filesystem winners always outrank them.
 */
export function mergeRegistry(fsSkills, registrySkills) {
  const names = new Set(fsSkills.map((skill) => skill.name))
  const merged = fsSkills.slice()
  for (const skill of registrySkills) {
    if (!isSkillName(skill.name) || names.has(skill.name)) continue
    names.add(skill.name)
    const meta = metaOf(skill.source)
    merged.push({
      name: skill.name,
      description: normalizeInline(skill.description),
      whenToUse: normalizeInline(skill.whenToUse),
      source: meta === SOURCE_META.runtime ? 'runtime' : skill.source,
      sourceLabel: meta.label,
      sourceShort: meta.short,
      group: meta.group,
      groupOrder: meta.order,
      rank: meta.rank,
      provider: typeof skill.provider === 'string' ? skill.provider : 'registry',
      path: undefined,
      directory: undefined,
      rootPath: undefined,
      readOnly: true,
      readOnlyReason: 'provider',
      link: false,
      modelInvocable: skill.modelInvocable !== false,
      userInvocable: skill.userInvocable !== false,
      chars: 0,
    })
  }
  return merged
}

/** Read the host-plane registry without requiring it to exist. */
export async function registryList(ctx, cwd) {
  let registry
  try {
    registry = ctx.get('skills')
  } catch (error) {
    return []
  }
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return []
  try {
    const options = {}
    if (typeof cwd === 'string' && cwd.length > 0) options.cwd = cwd
    const list = await registry.list(options)
    return list.map((skill) => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      source: typeof skill.source === 'string' ? skill.source : 'runtime',
      provider: skill.provider,
      modelInvocable: skill.invocation === undefined || skill.invocation.modelInvocable !== false,
      userInvocable: skill.invocation === undefined || skill.invocation.userInvocable !== false,
    }))
  } catch (error) {
    return []
  }
}

/** Attach the 7-day hit window and the stale verdict to each skill. */
export function decorateSkills(skills, summary) {
  return skills.map((skill) => {
    const entry = summary.byName.get(skill.name)
    return {
      ...skill,
      hits7: entry === undefined ? 0 : entry.hits7,
      hitsTotal: entry === undefined ? 0 : entry.hitsTotal,
      hitsOlder: entry === undefined ? 0 : entry.hitsOlder,
      lastHit: entry === undefined ? null : entry.last,
      daily: entry === undefined ? new Array(summary.days).fill(0) : entry.daily,
      recentHits: entry === undefined ? [] : entry.recent,
      stale: entry === undefined || entry.hits7 === 0,
    }
  })
}

/** Rank by the last-7-days count, then recency, then name. */
export function sortSkills(skills) {
  return skills.slice().sort((a, b) => {
    if (b.hits7 !== a.hits7) return b.hits7 - a.hits7
    const left = a.lastHit === null ? 0 : a.lastHit.at
    const right = b.lastHit === null ? 0 : b.lastHit.at
    if (right !== left) return right - left
    return a.name.localeCompare(b.name)
  })
}

/** Resolve a mutation target and refuse a stale path. */
export function findSkill(skills, name, path) {
  const skill = skills.find((entry) => entry.name === name)
  if (skill === undefined) return { error: '技能不存在或目录已变化，请刷新后重试' }
  if (typeof path === 'string' && path.length > 0 && skill.path !== undefined) {
    if (resolve(path) !== resolve(skill.path)) return { error: '路径与最新扫描结果不一致，请刷新后重试' }
  }
  return { skill }
}

function realOrResolve(path) {
  try {
    return realpathSync(path)
  } catch (error) {
    return resolve(path)
  }
}

function insideRoot(root, target) {
  const rel = relative(root, target)
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel))
}

function assertWritable(skill) {
  if (skill.readOnly || typeof skill.path !== 'string' || skill.path.length === 0) {
    const error = new Error('该技能由插件或注册表提供，没有可写的本地文件')
    error.code = 'READONLY'
    throw error
  }
  if (typeof skill.rootPath !== 'string' || skill.rootPath.length === 0) {
    const error = new Error('无法确定技能的来源根目录')
    error.code = 'READONLY'
    throw error
  }
  const root = resolve(skill.rootPath)
  const target = resolve(skill.path)
  if (!insideRoot(root, target)) {
    const error = new Error('技能路径不在其来源根目录内')
    error.code = 'READONLY'
    throw error
  }
  // A skill directory can be a junction/symlink. Resolve both sides before
  // writing so a link cannot turn a harmless panel toggle into an outside write.
  const realRoot = realOrResolve(root)
  const realTarget = realOrResolve(target)
  if (!insideRoot(realRoot, realTarget)) {
    const error = new Error('技能通过符号链接指向其来源根目录之外，已按只读处理')
    error.code = 'READONLY'
    throw error
  }
}

function writeAtomic(path, text) {
  const tmp = path + '.radar-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/** Flip the model-invocation switch by editing only the frontmatter key. */
export function toggleSkill(skill, enabled) {
  assertWritable(skill)
  const raw = readFileSync(skill.path, 'utf8')
  const next = setModelInvocable(raw, enabled === true)
  if (next !== raw) writeAtomic(skill.path, next)
  return { path: skill.path, modelInvocable: enabled === true }
}

/** Create a new user-level or project-level skill without overwriting. */
export function createSkill(input) {
  const name = normalizeInline(input.name)
  const description = normalizeInline(input.description)
  const whenToUse = normalizeInline(input.whenToUse)
  const content = typeof input.content === 'string' ? input.content : ''
  if (!isSkillName(name)) {
    const error = new Error('技能名必须是 kebab-case（小写字母、数字、连字符）')
    error.code = 'INVALID'
    throw error
  }
  if (description.length === 0 || description.length > MAX_DESCRIPTION) {
    const error = new Error('描述不能为空，且不超过 ' + MAX_DESCRIPTION + ' 个字符')
    error.code = 'INVALID'
    throw error
  }
  if (content.length > MAX_CONTENT) {
    const error = new Error('正文不能超过 64KB')
    error.code = 'INVALID'
    throw error
  }

  const scope = input.scope === 'project' ? 'project' : 'user'
  const rootPath =
    scope === 'project'
      ? join(findProjectRoot(input.cwd), '.dsh', 'skills')
      : join(input.dshHome, 'skills')
  const targetDir = join(rootPath, name)
  const targetFile = join(targetDir, 'SKILL.md')
  if (existsSync(targetDir) || existsSync(join(rootPath, name + '.md'))) {
    const error = new Error('同名技能已存在，未覆盖')
    error.code = 'EEXIST'
    throw error
  }

  const document = renderSkillDocument({ name, description, whenToUse, content })
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(targetFile, document, 'utf8')
  return { path: targetFile, rootPath, scope, name }
}

function stamp(date) {
  const pad = (value) => (value < 10 ? '0' + value : String(value))
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

function parseStamp(datePart, timePart) {
  const year = Number(datePart.slice(0, 4))
  const month = Number(datePart.slice(4, 6))
  const day = Number(datePart.slice(6, 8))
  const hour = Number(timePart.slice(0, 2))
  const minute = Number(timePart.slice(2, 4))
  const second = Number(timePart.slice(4, 6))
  return new Date(year, month - 1, day, hour, minute, second).getTime()
}

/** Move one skill into its root's `.trash`, the same recoverable path the Skill Center uses. */
export function archiveSkill(skill, now = Date.now()) {
  assertWritable(skill)
  let sourcePath
  let entryName
  if (basename(skill.path) === 'SKILL.md') {
    sourcePath = dirname(skill.path)
    entryName = basename(sourcePath)
  } else {
    sourcePath = skill.path
    entryName = basename(skill.path)
  }

  const trashDir = join(skill.rootPath, '.trash')
  mkdirSync(trashDir, { recursive: true })
  const prefix = stamp(new Date(now))
  let entry = prefix + '-' + entryName
  let suffix = 1
  while (existsSync(join(trashDir, entry))) {
    suffix += 1
    entry = prefix + '-' + entryName + '~' + suffix
  }
  renameSync(sourcePath, join(trashDir, entry))
  return { entry, entryName, rootPath: skill.rootPath, trashDir, name: skill.name }
}

/** List recoverable skills across every writable root's `.trash`. */
export function listTrash(roots) {
  const items = []
  for (const root of roots) {
    if (!root.writable) continue
    const trashDir = join(root.path, '.trash')
    let entries
    try {
      entries = readdirSync(trashDir, { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const entry of entries) {
      const match = /^(\d{8})-(\d{6})-(.+)$/.exec(entry.name)
      if (match === null) continue
      const original = match[3].replace(/~\d+$/, '')
      const name = original.endsWith('.md') ? original.slice(0, -3) : original
      if (!isSkillName(name)) continue
      const full = join(trashDir, entry.name)
      let kind = 'dir'
      try {
        kind = lstatSync(full).isDirectory() ? 'dir' : 'file'
      } catch (error) {
        continue
      }
      const id = Buffer.from(JSON.stringify([root.path, entry.name]), 'utf8').toString('base64url')
      const meta = metaOf(root.source)
      items.push({
        id,
        name,
        entry: entry.name,
        at: parseStamp(match[1], match[2]),
        kind,
        source: root.source,
        sourceLabel: meta.label,
        sourceShort: meta.short,
        root: root.path,
      })
    }
  }
  items.sort((a, b) => b.at - a.at)
  return items
}

/** Restore one trashed skill by id; the id is resolved against a fresh scan. */
export function restoreTrash(id, roots) {
  const item = listTrash(roots).find((entry) => entry.id === id)
  if (item === undefined) {
    const error = new Error('回收站条目不存在或已恢复')
    error.code = 'ENOENT'
    throw error
  }
  const target = join(item.root, item.entry.replace(/^\d{8}-\d{6}-/, '').replace(/~\d+$/, ''))
  if (existsSync(target)) {
    const error = new Error('恢复位置已有同名技能，请先处理冲突')
    error.code = 'EEXIST'
    throw error
  }
  renameSync(join(item.root, '.trash', item.entry), target)
  return { name: item.name, path: target, root: item.root }
}

/** Serializable skill projection for the panel. */
export function publicSkill(skill) {
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    source: skill.source,
    sourceLabel: skill.sourceLabel,
    sourceShort: skill.sourceShort,
    group: skill.group,
    groupOrder: skill.groupOrder,
    provider: skill.provider,
    path: skill.path,
    readOnly: skill.readOnly,
    readOnlyReason: skill.readOnlyReason,
    link: skill.link,
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    hits7: skill.hits7,
    hitsTotal: skill.hitsTotal,
    hitsOlder: skill.hitsOlder,
    lastHit: skill.lastHit,
    daily: skill.daily,
    recentHits: skill.recentHits,
    stale: skill.stale,
    chars: skill.chars,
  }
}

export { MAX_CONTENT, MAX_DESCRIPTION }
