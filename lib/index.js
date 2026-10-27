// Host half of dsh-skill-radar.
//
// Records skill usage from the two places a skill can actually fire:
//   tools/result   — the model called the `skill` tool
//   session/event  — the user typed `/name`, which becomes a skill-invocation message
//
// Serves the panel at /dsh-skill-radar and owns every filesystem mutation:
// toggling frontmatter, creating a SKILL.md, archiving to `.trash`, restoring.
//
// The panel is disposable: if `webServer.register` fails, hit recording keeps
// working and the plugin stays mounted. Nothing here can block a tool call.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_WINDOW_DAYS, HitStore } from './hits.js'
import { isSkillName } from './frontmatter.js'
import {
  archiveSkill,
  createSkill,
  decorateSkills,
  findProjectRoot,
  findSkill,
  listTrash,
  mergeRegistry,
  publicSkill,
  registryList,
  resolveRoots,
  restoreTrash,
  scanRoots,
  sortSkills,
  toggleSkill,
} from './skills.js'

export const name = 'dsh-skill-radar'
export const inject = ['webServer']

const MAX_BODY = 2 * 1024 * 1024
const PROMPT_MAX = 200

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let raw = ''
    let tooLarge = false
    let settled = false
    function finish(kind, value) {
      if (settled) return
      settled = true
      if (kind === 'reject') reject(value)
      else resolve(value)
    }
    req.on('data', function (chunk) {
      if (tooLarge) return
      raw += chunk
      if (raw.length > MAX_BODY) {
        tooLarge = true
        raw = ''
      }
    })
    req.on('end', function () {
      if (tooLarge) {
        const error = new Error('请求体超过 2 MiB')
        error.code = 'INVALID'
        return finish('reject', error)
      }
      if (raw.length === 0) return finish('resolve', {})
      try {
        const parsed = JSON.parse(raw)
        finish('resolve', parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        finish('resolve', {})
      }
    })
    req.on('error', function () {
      finish('resolve', {})
    })
    req.on('close', function () {
      if (!settled) finish('resolve', {})
    })
  })
}

function methodFromUrl(url) {
  const path = String(url || '').split('?')[0]
  const rest = path.replace(/^\/dsh-skill-radar\/?/, '')
  return rest || 'state'
}

function queryFromUrl(url) {
  try {
    return new URL(String(url || '/'), 'http://127.0.0.1').searchParams
  } catch (error) {
    return new URLSearchParams()
  }
}

function errorMessage(error) {
  return String((error && error.message) || error)
}

function statusFor(error) {
  const code = error && error.code
  if (code === 'INVALID') return 400
  if (code === 'ENOENT') return 404
  if (code === 'EEXIST' || code === 'READONLY') return 409
  return 500
}

function addressIsLoopback(address) {
  const value = String(address || '')
  return (
    value === '::1' ||
    value === '::ffff:127.0.0.1' ||
    value.startsWith('127.') ||
    value.startsWith('::ffff:127.')
  )
}

function hostIsLoopback(host) {
  const value = String(host || '').toLowerCase()
  if (value.length === 0) return true
  const namePart = value.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return namePart === 'localhost' || namePart === '127.0.0.1' || namePart === '::1'
}

function isLoopback(req) {
  if (!addressIsLoopback(req.socket && req.socket.remoteAddress)) return false
  return hostIsLoopback(req.headers && req.headers.host)
}

function sameOrigin(req) {
  const origin = req.headers && req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    const parsed = new URL(origin)
    const host = String((req.headers && req.headers.host) || '').toLowerCase()
    return parsed.host.toLowerCase() === host || hostIsLoopback(parsed.host)
  } catch (error) {
    return false
  }
}

function sessionIdOf(session) {
  try {
    if (session === null || session === undefined) return ''
    if (session.header && typeof session.header.id === 'string') return session.header.id
    if (typeof session.id === 'string') return session.id
  } catch (error) {
    // Ignore a session shape we do not recognise.
  }
  return ''
}

function cwdOf(session) {
  try {
    if (session !== null && session !== undefined && session.header && typeof session.header.cwd === 'string') {
      return session.header.cwd
    }
  } catch (error) {
    // Ignore.
  }
  return ''
}

function titleOf(ctx, session) {
  try {
    const service = ctx.get('sessionTitle')
    if (service !== undefined && service !== null && typeof service.get === 'function' && session !== null && session !== undefined) {
      const snapshot = service.get(session)
      if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.title === 'string') {
        return snapshot.title
      }
    }
  } catch (error) {
    // Title is a display nicety only.
  }
  return ''
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text + ' '
    }
  }
  return text.trim()
}

function lastUserPrompt(session) {
  try {
    if (session === null || session === undefined || typeof session.snapshotEvents !== 'function') return ''
    const events = session.snapshotEvents()
    if (!Array.isArray(events)) return ''
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
      const data = event.data
      if (data === null || typeof data !== 'object') continue
      if (data.source === null || typeof data.source !== 'object' || data.source.kind !== 'user') continue
      const text = textOfContent(data.content)
      if (text.length > 0) return text.slice(0, PROMPT_MAX)
    }
  } catch (error) {
    // A session that cannot be read must not affect hit recording.
  }
  return ''
}

function guessTrigger(skillName, prompt) {
  if (typeof prompt === 'string' && prompt.length > 0) {
    const gesture = new RegExp('(^|\\s)/' + skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)')
    if (gesture.test(prompt)) return '/' + skillName
  }
  return skillName
}

function defaultCwd(ctx) {
  try {
    const service = ctx.get('workingDirectory')
    if (service !== undefined && service !== null && typeof service.defaultDirectory === 'string') {
      return service.defaultDirectory
    }
  } catch (error) {
    // Optional service.
  }
  return undefined
}

function buildGroups(skills) {
  const groups = new Map()
  for (const skill of skills) {
    let group = groups.get(skill.group)
    if (group === undefined) {
      group = { key: skill.group, label: skill.group, order: skill.groupOrder, skills: [] }
      groups.set(skill.group, group)
    }
    group.skills.push(skill)
  }
  return Array.from(groups.values()).sort((a, b) => a.order - b.order)
}

export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const home = typeof settings.dshHome === 'string' ? settings.dshHome : dshHome()
  const agentsHome =
    typeof settings.agentsHome === 'string'
      ? settings.agentsHome
      : typeof process.env.DSH_AGENTS_HOME === 'string' && process.env.DSH_AGENTS_HOME.length > 0
        ? process.env.DSH_AGENTS_HOME
        : join(homedir(), '.agents')
  const customSkillDirs = Array.isArray(settings.customSkillDirs)
    ? settings.customSkillDirs.filter((dir) => typeof dir === 'string' && dir.trim().length > 0)
    : []
  const windowDays =
    Number.isInteger(settings.windowDays) && settings.windowDays > 0 ? settings.windowDays : DEFAULT_WINDOW_DAYS
  const hitsPath = typeof settings.hitsPath === 'string' ? settings.hitsPath : join(home, 'skill-radar', 'hits.jsonl')
  const allowRemote = settings.allowRemote === true

  const store = new HitStore({
    filePath: hitsPath,
    now: typeof settings.now === 'function' ? settings.now : undefined,
    max: Number.isInteger(settings.maxHits) && settings.maxHits > 0 ? settings.maxHits : undefined,
    retentionDays:
      Number.isInteger(settings.retentionDays) && settings.retentionDays > 0 ? settings.retentionDays : undefined,
  })

  let mounted = false
  ctx.effect(function () {
    mounted = true
    return function () {
      mounted = false
    }
  })

  function record(input) {
    if (!mounted) return undefined
    return store.record(input)
  }

  // A model-loaded skill. Failures are not usage, and neither is another tool.
  ctx.on('tools/result', function (exec, result) {
    try {
      if (exec === null || typeof exec !== 'object' || exec.name !== 'skill') return
      if (result !== null && typeof result === 'object' && result.isError === true) return
      const args = exec.arguments
      if (args === null || typeof args !== 'object' || typeof args.name !== 'string') return
      const skillName = args.name.trim()
      if (!isSkillName(skillName)) return
      const session = exec.agent && exec.agent.session
      const prompt = lastUserPrompt(session)
      record({
        at: Date.now(),
        name: skillName,
        session: sessionIdOf(session),
        title: titleOf(ctx, session),
        trigger: guessTrigger(skillName, prompt),
        prompt,
        via: 'tool',
        cwd: cwdOf(session),
      })
    } catch (error) {
      // Observability must never break a tool call.
    }
  })

  // A user gesture: `/name` is injected as a skill-invocation user message.
  ctx.on('session/event', function (session, event) {
    try {
      if (event === null || typeof event !== 'object' || event.type !== 'user/message') return
      const data = event.data
      if (data === null || typeof data !== 'object') return
      const source = data.source
      if (source === null || typeof source !== 'object' || source.kind !== 'skill-invocation') return
      if (typeof source.name !== 'string') return
      const skillName = source.name.trim()
      if (!isSkillName(skillName)) return
      record({
        at: Number.isFinite(event.time) ? event.time : Date.now(),
        name: skillName,
        session: sessionIdOf(session),
        title: titleOf(ctx, session),
        trigger: '/' + skillName,
        prompt: textOfContent(data.content).slice(0, PROMPT_MAX),
        via: 'gesture',
        cwd: cwdOf(session),
      })
    } catch (error) {
      // Same containment as above.
    }
  })

  function resolveCwd(parameters) {
    const requested = parameters.get('cwd')
    if (typeof requested === 'string' && requested.length > 0 && existsSync(requested)) return requested
    const fromLedger = store.lastCwd()
    if (typeof fromLedger === 'string' && fromLedger.length > 0 && existsSync(fromLedger)) return fromLedger
    const fallback = defaultCwd(ctx)
    if (typeof fallback === 'string' && fallback.length > 0) return fallback
    return process.cwd()
  }

  async function catalogFor(cwd) {
    const roots = resolveRoots({ cwd, dshHome: home, agentsHome, customSkillDirs })
    const scan = scanRoots(roots)
    const registry = await registryList(ctx, cwd)
    return { roots, skills: mergeRegistry(scan.skills, registry), shadowed: scan.shadowed }
  }

  async function stateFor(url) {
    const parameters = queryFromUrl(url)
    const cwd = resolveCwd(parameters)
    const catalog = await catalogFor(cwd)
    const now = Date.now()
    const summary = store.summary(now, windowDays)
    const decorated = decorateSkills(catalog.skills, summary)
    const sorted = sortSkills(decorated)
    const trash = listTrash(catalog.roots)
    const stale = sorted.filter((skill) => skill.stale).length
    return {
      ok: true,
      now,
      windowDays,
      cwd,
      projectRoot: findProjectRoot(cwd),
      dailyLabels: summary.dailyLabels,
      skills: sorted.map(publicSkill),
      groups: buildGroups(sorted),
      trash,
      roots: catalog.roots.map((root) => ({
        path: root.path,
        source: root.source,
        label: root.label,
        writable: root.writable,
      })),
      shadowed: catalog.shadowed,
      stats: {
        skills: sorted.length,
        hits7: summary.totalHits7,
        stale,
        trash: trash.length,
        sessions: summary.sessions.length,
        readOnly: sorted.filter((skill) => skill.readOnly).length,
      },
    }
  }

  async function handleState(req, res) {
    sendJson(res, 200, await stateFor(req.url))
  }

  async function handleToggle(req, res, body) {
    const cwd = resolveCwd(queryFromUrl(req.url))
    const catalog = await catalogFor(cwd)
    const found = findSkill(catalog.skills, String(body.name || ''), body.path)
    if (found.error !== undefined) return sendJson(res, 409, { ok: false, error: found.error })
    const result = toggleSkill(found.skill, body.enabled === true)
    sendJson(res, 200, { ok: true, ...result })
  }

  async function handleCreate(req, res, body) {
    const cwd = resolveCwd(queryFromUrl(req.url))
    const result = createSkill({
      name: body.name,
      description: body.description,
      whenToUse: body.whenToUse,
      content: body.content,
      scope: body.scope,
      cwd,
      dshHome: home,
    })
    sendJson(res, 200, { ok: true, ...result })
  }

  async function handleArchive(req, res, body) {
    const cwd = resolveCwd(queryFromUrl(req.url))
    const catalog = await catalogFor(cwd)
    const found = findSkill(catalog.skills, String(body.name || ''), body.path)
    if (found.error !== undefined) return sendJson(res, 409, { ok: false, error: found.error })
    const result = archiveSkill(found.skill)
    sendJson(res, 200, { ok: true, ...result })
  }

  async function handleRestore(req, res, body) {
    const cwd = resolveCwd(queryFromUrl(req.url))
    const roots = resolveRoots({ cwd, dshHome: home, agentsHome, customSkillDirs })
    const result = restoreTrash(String(body.id || ''), roots)
    sendJson(res, 200, { ok: true, ...result })
  }

  async function handleClear(req, res, body) {
    if (body.confirm !== true) {
      return sendJson(res, 400, { ok: false, error: '清空命中记录需要 confirm: true' })
    }
    store.clear()
    sendJson(res, 200, { ok: true, cleared: true })
  }

  async function handler(req, res) {
    try {
      if (!allowRemote && !isLoopback(req)) {
        return sendJson(res, 403, { ok: false, error: 'loopback only' })
      }
      if (!sameOrigin(req)) {
        return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
      }

      const method = methodFromUrl(req.url)
      if (req.method === 'GET') {
        if (method === 'health') {
          return sendJson(res, 200, {
            ok: true,
            name,
            windowDays,
            hitsPath,
            hits: store.hits.length,
          })
        }
        if (method === 'state') return await handleState(req, res)
        return sendJson(res, 404, { ok: false, error: 'unknown method' })
      }

      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      if (req.headers['x-dsh-skill-radar'] !== '1') {
        return sendJson(res, 403, { ok: false, error: 'missing same-origin request marker' })
      }

      const body = await readBody(req)
      switch (method) {
        case 'toggle':
          return await handleToggle(req, res, body)
        case 'create':
          return await handleCreate(req, res, body)
        case 'archive':
          return await handleArchive(req, res, body)
        case 'restore':
          return await handleRestore(req, res, body)
        case 'clear-hits':
          return await handleClear(req, res, body)
        default:
          return sendJson(res, 404, { ok: false, error: 'unknown method' })
      }
    } catch (error) {
      sendJson(res, statusFor(error), { ok: false, error: errorMessage(error) })
    }
  }

  // The gate keeps recording if the route cannot mount; the panel is the
  // disposable half. Cordis still unwinds the listener with the fiber.
  ctx.effect(function () {
    let dispose
    try {
      dispose = ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-skill-radar',
        handler,
      })
    } catch (error) {
      dispose = undefined
    }
    return function () {
      if (typeof dispose === 'function') dispose()
    }
  })
}
