// Shared fixtures for the host tests. These drive the real apply() against a
// stub ctx and the real HTTP handler against a tiny request/response pair.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../src/host.js'

export function tempHome() {
  return mkdtempSync(join(tmpdir(), 'radar-test-'))
}

export function writeSkill(root, name, options = {}) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  const lines = ['---', 'name: ' + name, 'description: ' + (options.description || 'desc ' + name)]
  if (options.whenToUse) lines.push('whenToUse: ' + options.whenToUse)
  if (options.disableModelInvocation === true) lines.push('disable-model-invocation: true')
  if (options.userInvocable === false) lines.push('user-invocable: false')
  lines.push('---', '', options.body || '# ' + name, '')
  const file = join(directory, 'SKILL.md')
  writeFileSync(file, lines.join('\n'))
  return { directory, file }
}

export function writeFlatSkill(root, fileName, options = {}) {
  mkdirSync(root, { recursive: true })
  const file = join(root, fileName + '.md')
  writeFileSync(
    file,
    ['---', 'name: ' + fileName, 'description: ' + (options.description || 'flat ' + fileName), '---', '', '# body', ''].join('\n'),
  )
  return file
}

export function seedHits(home, hits) {
  const path = join(home, 'skill-radar', 'hits.jsonl')
  mkdirSync(join(home, 'skill-radar'), { recursive: true })
  writeFileSync(path, hits.map((hit) => JSON.stringify(hit)).join('\n') + '\n')
  return path
}

export function fakeSession(options = {}) {
  const events = options.events || []
  return {
    header: { id: options.id || 'session-1', cwd: options.cwd || 'D:/work/demo' },
    snapshotEvents() {
      return events
    },
  }
}

export function userMessage(text) {
  return {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: text }] },
  }
}

export function setupHarness(options = {}) {
  const listeners = new Map()
  const routes = []
  const disposers = []
  const services = { ...(options.services || {}) }

  const webServer = {
    register(route) {
      if (options.registerThrows === true) throw new Error('webServer.register is unavailable')
      routes.push(route)
      return function () {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }

  const ctx = {
    webServer,
    get(name) {
      return services[name]
    },
    on(event, listener) {
      listeners.set(event, listener)
      const dispose = function () {
        if (listeners.get(event) === listener) listeners.delete(event)
      }
      disposers.push(dispose)
      return dispose
    },
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : function () {}
      disposers.push(wrapped)
      return wrapped
    },
  }

  const home = options.home || tempHome()
  apply(ctx, {
    dshHome: home,
    agentsHome: join(home, 'agents'),
    customSkillDirs: options.customSkillDirs || [],
    ...(options.config || {}),
  })

  return {
    home,
    listeners,
    routes,
    services,
    dispose() {
      const pending = disposers.splice(0)
      for (const dispose of pending) dispose()
    },
    async callRoute(request = {}) {
      const route = routes.find((entry) => entry.path === '/dsh-skill-radar')
      if (route === undefined) throw new Error('route is not registered')
      const bodyText = request.body === undefined ? '' : JSON.stringify(request.body)
      const req = Readable.from(bodyText.length > 0 ? [bodyText] : [])
      req.method = request.method || 'GET'
      req.url = request.url || '/dsh-skill-radar/state'
      req.headers = { host: '127.0.0.1:3000', ...(request.headers || {}) }
      req.socket = { remoteAddress: request.remoteAddress || '127.0.0.1' }
      const res = {
        statusCode: 0,
        headers: {},
        chunks: [],
        setHeader(key, value) {
          this.headers[key.toLowerCase()] = value
        },
        end(chunk) {
          if (chunk !== undefined) this.chunks.push(String(chunk))
        },
      }
      await route.handler(req, res)
      const text = res.chunks.join('')
      return { status: res.statusCode, headers: res.headers, text, json: text.length > 0 ? JSON.parse(text) : {} }
    },
  }
}
