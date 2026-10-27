import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fakeSession, seedHits, setupHarness, tempHome, userMessage, writeSkill } from '../test-support/helpers.mjs'

const MARKER = { 'x-dsh-skill-radar': '1' }
const DAY = 86_400_000

function toolHit(harness, name, session) {
  const listener = harness.listeners.get('tools/result')
  assert.ok(listener, 'tools/result listener is registered')
  listener({ name: 'skill', arguments: { name: name }, callId: 'call-1', agent: { session: session } }, { isError: false })
}

test('a successful skill tool call is recorded with time, session and trigger', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  const session = fakeSession({ id: 'session-1', cwd: home, events: [userMessage('please /alpha this repo')] })
  const harness = setupHarness({
    home,
    services: { sessionTitle: { get: () => ({ title: '会话一' }) } },
  })

  toolHit(harness, 'alpha', session)
  const response = await harness.callRoute()
  assert.equal(response.status, 200)
  const alpha = response.json.skills.find((skill) => skill.name === 'alpha')
  assert.equal(alpha.hits7, 1)
  assert.equal(alpha.stale, false)
  assert.equal(alpha.lastHit.session, 'session-1')
  assert.equal(alpha.lastHit.title, '会话一')
  assert.equal(alpha.lastHit.trigger, '/alpha')
  assert.ok(alpha.lastHit.at > 0)
  assert.equal(response.json.stats.hits7, 1)
})

test('failed calls and other tools never enter the ledger', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  const harness = setupHarness({ home })
  const listener = harness.listeners.get('tools/result')
  const session = fakeSession({ cwd: home })

  listener({ name: 'skill', arguments: { name: 'alpha' }, agent: { session } }, { isError: true })
  listener({ name: 'pwsh', arguments: { name: 'alpha' }, agent: { session } }, { isError: false })
  listener({ name: 'skill', arguments: { name: 'Bad Name' }, agent: { session } }, { isError: false })

  const response = await harness.callRoute()
  assert.equal(response.json.stats.hits7, 0)
  assert.equal(response.json.skills.find((skill) => skill.name === 'alpha').stale, true)
})

test('a /name gesture is recorded even though it makes no tool call', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'beta')
  const harness = setupHarness({ home })
  const session = fakeSession({ id: 'gesture-session', cwd: home })
  const listener = harness.listeners.get('session/event')
  listener(session, {
    type: 'user/message',
    time: Date.now(),
    data: {
      source: { kind: 'skill-invocation', name: 'beta', form: 'instructions' },
      content: [{ type: 'text', text: '/beta 走一遍发布检查' }],
    },
  })

  const response = await harness.callRoute()
  const beta = response.json.skills.find((skill) => skill.name === 'beta')
  assert.equal(beta.hits7, 1)
  assert.equal(beta.lastHit.via, 'gesture')
  assert.equal(beta.lastHit.trigger, '/beta')
  assert.match(beta.lastHit.prompt, /发布检查/)
})

test('a gesture and the load it causes collapse to one hit', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  const harness = setupHarness({ home })
  const session = fakeSession({ id: 's1', cwd: home })
  toolHit(harness, 'alpha', session)
  harness.listeners.get('session/event')(session, {
    type: 'user/message',
    time: Date.now(),
    data: {
      source: { kind: 'skill-invocation', name: 'alpha' },
      content: [{ type: 'text', text: '/alpha go' }],
    },
  })

  const response = await harness.callRoute()
  const alpha = response.json.skills.find((skill) => skill.name === 'alpha')
  assert.equal(alpha.hits7, 1)
  assert.equal(alpha.lastHit.via, 'gesture')
})

test('skills are ranked by 7-day hits and zero-hit skills are marked stale', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  writeSkill(join(home, 'skills'), 'beta')
  writeSkill(join(home, 'skills'), 'gamma')
  const now = Date.now()
  seedHits(home, [
    { at: now - 1000, name: 'alpha', session: 's1', via: 'tool', trigger: 'alpha' },
    { at: now - 2000, name: 'alpha', session: 's2', via: 'gesture', trigger: '/alpha' },
    { at: now - 8 * DAY, name: 'gamma', session: 's3', via: 'tool', trigger: 'gamma' },
  ])
  const harness = setupHarness({ home })
  const response = await harness.callRoute()
  const names = response.json.skills.map((skill) => skill.name)
  assert.deepEqual(names, ['alpha', 'gamma', 'beta'])
  const gamma = response.json.skills.find((skill) => skill.name === 'gamma')
  assert.equal(gamma.hits7, 0)
  assert.equal(gamma.hitsOlder, 1)
  assert.equal(gamma.stale, true)
  assert.notEqual(gamma.lastHit, null)
  const beta = response.json.skills.find((skill) => skill.name === 'beta')
  assert.equal(beta.lastHit, null)
  assert.equal(response.json.stats.stale, 2)
  assert.equal(response.json.stats.hits7, 2)
})

test('state and mutations honor an explicit session cwd over the last ledger cwd', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  const other = join(home, 'other')
  mkdirSync(other, { recursive: true })
  seedHits(home, [{ at: Date.now(), name: 'alpha', session: 's1', cwd: other }])

  const project = join(home, 'app')
  mkdirSync(join(project, '.git'), { recursive: true })
  writeSkill(join(project, '.dsh', 'skills'), 'project-only')

  const harness = setupHarness({ home })
  const fallback = await harness.callRoute()
  assert.equal(fallback.json.cwd, other)
  assert.equal(fallback.json.skills.some((skill) => skill.name === 'project-only'), false)

  const response = await harness.callRoute({ url: '/dsh-skill-radar/state?cwd=' + encodeURIComponent(project) })
  assert.equal(response.json.cwd, project)
  assert.equal(response.json.projectRoot, project)
  const target = response.json.skills.find((skill) => skill.name === 'project-only')
  assert.ok(target)

  const toggled = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/toggle?cwd=' + encodeURIComponent(project),
    body: { name: 'project-only', path: target.path, enabled: false },
    headers: MARKER,
  })
  assert.equal(toggled.status, 200)
  assert.match(readFileSync(target.path, 'utf8'), /disable-model-invocation: true/)
})

test('an oversized request body is rejected instead of hanging', async () => {
  const harness = setupHarness({ home: tempHome() })
  const response = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/toggle',
    headers: MARKER,
    body: { name: 'alpha', enabled: false, padding: 'x'.repeat(2 * 1024 * 1024 + 16) },
  })
  assert.equal(response.status, 400)
  assert.match(response.json.error, /2 MiB/)
})

test('registry-only skills are listed read-only', async () => {
  const home = tempHome()
  const services = {
    skills: {
      async list() {
        return [
          {
            name: 'vendor-skill',
            description: 'ships inside a plugin',
            source: 'bundled',
            provider: 'some-plugin',
            invocation: { modelInvocable: true, userInvocable: true },
          },
        ]
      },
    },
  }
  const harness = setupHarness({ home, services })
  const response = await harness.callRoute()
  const vendor = response.json.skills.find((skill) => skill.name === 'vendor-skill')
  assert.equal(vendor.readOnly, true)
  assert.equal(vendor.sourceLabel, '系统内置')
  assert.equal(response.json.stats.readOnly, 1)
})

test('toggle writes frontmatter, and a stale path is rejected', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  const harness = setupHarness({ home })
  const first = await harness.callRoute()
  const alpha = first.json.skills.find((skill) => skill.name === 'alpha')

  const off = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/toggle',
    headers: MARKER,
    body: { name: 'alpha', path: alpha.path, enabled: false },
  })
  assert.equal(off.status, 200)
  assert.match(readFileSync(alpha.path, 'utf8'), /disable-model-invocation: true/)
  const second = await harness.callRoute()
  assert.equal(second.json.skills.find((skill) => skill.name === 'alpha').modelInvocable, false)

  const on = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/toggle',
    headers: MARKER,
    body: { name: 'alpha', path: alpha.path, enabled: true },
  })
  assert.equal(on.status, 200)
  assert.doesNotMatch(readFileSync(alpha.path, 'utf8'), /disable-model-invocation/)

  const stale = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/toggle',
    headers: MARKER,
    body: { name: 'alpha', path: 'D:\\elsewhere\\SKILL.md', enabled: false },
  })
  assert.equal(stale.status, 409)
})

test('read-only skills cannot be archived or toggled', async () => {
  const home = tempHome()
  const harness = setupHarness({
    home,
    services: {
      skills: {
        async list() {
          return [{ name: 'vendor-skill', description: 'x', source: 'bundled', provider: 'p' }]
        },
      },
    },
  })
  const archived = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/archive',
    headers: MARKER,
    body: { name: 'vendor-skill' },
  })
  assert.equal(archived.status, 409)
  const toggled = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/toggle',
    headers: MARKER,
    body: { name: 'vendor-skill', enabled: false },
  })
  assert.equal(toggled.status, 409)
})

test('create writes a skill and the next state contains it', async () => {
  const home = tempHome()
  const harness = setupHarness({ home })
  const created = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/create',
    headers: MARKER,
    body: { name: 'created-skill', description: 'from the panel', scope: 'user', whenToUse: 'when testing' },
  })
  assert.equal(created.status, 200)
  assert.ok(existsSync(join(home, 'skills', 'created-skill', 'SKILL.md')))

  const state = await harness.callRoute()
  const skill = state.json.skills.find((entry) => entry.name === 'created-skill')
  assert.equal(skill.whenToUse, 'when testing')
  assert.equal(skill.stale, true)

  const duplicate = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/create',
    headers: MARKER,
    body: { name: 'created-skill', description: 'again', scope: 'user' },
  })
  assert.equal(duplicate.status, 409)

  const invalid = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/create',
    headers: MARKER,
    body: { name: 'Bad Name', description: 'x', scope: 'user' },
  })
  assert.equal(invalid.status, 400)
})

test('archive moves a skill to .trash, state exposes it, restore brings it back', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  const harness = setupHarness({ home })
  const first = await harness.callRoute()
  const alpha = first.json.skills.find((skill) => skill.name === 'alpha')

  const archived = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/archive',
    headers: MARKER,
    body: { name: 'alpha', path: alpha.path },
  })
  assert.equal(archived.status, 200)
  assert.equal(existsSync(join(home, 'skills', 'alpha')), false)

  const after = await harness.callRoute()
  assert.equal(after.json.trash.length, 1)
  assert.equal(after.json.trash[0].name, 'alpha')
  assert.equal(after.json.skills.some((skill) => skill.name === 'alpha'), false)

  const restored = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/restore',
    headers: MARKER,
    body: { id: after.json.trash[0].id },
  })
  assert.equal(restored.status, 200)
  assert.ok(existsSync(join(home, 'skills', 'alpha', 'SKILL.md')))
  const final = await harness.callRoute()
  assert.equal(final.json.trash.length, 0)
  assert.equal(final.json.skills.some((skill) => skill.name === 'alpha'), true)
})

test('mutations require the same-origin marker and a same-origin Origin', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  const harness = setupHarness({ home })
  const first = await harness.callRoute()
  const alpha = first.json.skills.find((skill) => skill.name === 'alpha')

  const noMarker = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/toggle',
    body: { name: 'alpha', path: alpha.path, enabled: false },
  })
  assert.equal(noMarker.status, 403)
  assert.doesNotMatch(readFileSync(alpha.path, 'utf8'), /disable-model-invocation/)

  const crossOrigin = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/toggle',
    headers: { ...MARKER, origin: 'https://evil.example' },
    body: { name: 'alpha', path: alpha.path, enabled: false },
  })
  assert.equal(crossOrigin.status, 403)
})

test('a non-loopback request is refused before any filesystem work', async () => {
  const home = tempHome()
  const harness = setupHarness({ home })
  const response = await harness.callRoute({ remoteAddress: '10.1.2.3' })
  assert.equal(response.status, 403)
  assert.equal(response.json.error, 'loopback only')
})

test('health, unknown methods and clear-hits behave', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  const harness = setupHarness({ home })
  toolHit(harness, 'alpha', fakeSession({ cwd: home }))

  const health = await harness.callRoute({ url: '/dsh-skill-radar/health' })
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)
  assert.equal(health.json.windowDays, 7)

  const missing = await harness.callRoute({ url: '/dsh-skill-radar/nope' })
  assert.equal(missing.status, 404)

  const clear = await harness.callRoute({
    method: 'POST',
    url: '/dsh-skill-radar/clear-hits',
    headers: MARKER,
    body: { confirm: true },
  })
  assert.equal(clear.status, 200)
  const state = await harness.callRoute()
  assert.equal(state.json.stats.hits7, 0)
})

test('a corrupt ledger line does not hide the valid rows', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  seedHits(home, [{ at: Date.now(), name: 'alpha', session: 's1', via: 'tool', trigger: 'alpha' }])
  const path = join(home, 'skill-radar', 'hits.jsonl')
  const valid = readFileSync(path, 'utf8')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path, 'garbage line\n' + valid)

  const harness = setupHarness({ home })
  const response = await harness.callRoute()
  assert.equal(response.json.stats.hits7, 1)
})

test('unload removes the route and stops recording, even for a captured listener', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  const harness = setupHarness({ home })
  const session = fakeSession({ cwd: home })
  toolHit(harness, 'alpha', session)
  const path = join(home, 'skill-radar', 'hits.jsonl')
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1)

  const captured = harness.listeners.get('tools/result')
  harness.dispose()
  assert.equal(harness.routes.length, 0)
  assert.equal(harness.listeners.size, 0)

  captured({ name: 'skill', arguments: { name: 'alpha' }, agent: { session } }, { isError: false })
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1)
})

test('a failed route registration still records hits', async () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  const harness = setupHarness({ home, registerThrows: true })
  assert.equal(harness.routes.length, 0)
  toolHit(harness, 'alpha', fakeSession({ cwd: home }))
  const path = join(home, 'skill-radar', 'hits.jsonl')
  assert.match(readFileSync(path, 'utf8'), /"name":"alpha"/)
})
