import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  archiveSkill,
  createSkill,
  findProjectRoot,
  findSkill,
  listTrash,
  mergeRegistry,
  resolveRoots,
  restoreTrash,
  scanRoots,
  toggleSkill,
} from '../src/skills.js'
import { tempHome, writeFlatSkill, writeSkill } from '../test-support/helpers.mjs'

function rootsFor(home, cwd) {
  return resolveRoots({
    dshHome: home,
    agentsHome: join(home, 'agents'),
    customSkillDirs: [join(home, 'custom-skills')],
    cwd,
  })
}

test('scans project, user, flat and custom roots with official ranks', () => {
  const home = tempHome()
  const project = join(home, 'project')
  mkdirSync(join(project, '.git'), { recursive: true })
  writeSkill(join(project, '.dsh', 'skills'), 'alpha', { description: 'project alpha' })
  writeSkill(join(home, 'skills'), 'alpha', { description: 'user alpha' })
  writeSkill(join(home, 'skills'), 'beta')
  writeFlatSkill(join(home, 'skills'), 'flat-skill')
  writeSkill(join(home, 'custom-skills'), 'gamma')
  writeSkill(join(home, 'agents', 'skills'), 'delta')

  const scan = scanRoots(rootsFor(home, project))
  const byName = new Map(scan.skills.map((skill) => [skill.name, skill]))
  assert.equal(byName.get('alpha').source, 'project-dsh')
  assert.equal(byName.get('alpha').description, 'project alpha')
  assert.equal(byName.get('beta').source, 'user-dsh')
  assert.equal(byName.get('flat-skill').source, 'user-dsh')
  assert.equal(byName.get('gamma').source, 'custom')
  assert.equal(byName.get('delta').source, 'user-agents')
  assert.equal(scan.shadowed, 1)
})

test('skips dot directories, .system and invalid SKILL.md files', () => {
  const home = tempHome()
  const user = join(home, 'skills')
  writeSkill(user, 'visible')
  writeSkill(join(user, '.trash'), 'trashed')
  writeSkill(join(user, '.system'), 'system')
  mkdirSync(join(user, 'missing-description'), { recursive: true })
  writeFileSync(join(user, 'missing-description', 'SKILL.md'), '---\nname: missing-description\n---\nbody\n')
  mkdirSync(join(user, 'Bad-Name'), { recursive: true })
  writeFileSync(join(user, 'Bad-Name', 'SKILL.md'), '---\nname: Bad-Name\ndescription: x\n---\nbody\n')

  const scan = scanRoots(rootsFor(home, home))
  assert.deepEqual(scan.skills.map((skill) => skill.name), ['visible'])
})

test('merges registry-only rows as read-only', () => {
  const merged = mergeRegistry(
    [],
    [
      { name: 'bundled-one', description: 'from a bundle', source: 'bundled', provider: 'pkg' },
      { name: 'runtime-one', description: 'from code', source: 'runtime', provider: 'pkg' },
    ],
  )
  assert.equal(merged.length, 2)
  assert.equal(merged[0].readOnly, true)
  assert.equal(merged[0].sourceLabel, '系统内置')
  assert.equal(merged[1].sourceLabel, '运行时注册')
})

test('a SKILL.md directly at a skills root is not a flat skill', () => {
  const root = join(tempHome(), 'skills')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), '---\nname: alpha\ndescription: root-level file\n---\n')
  const scan = scanRoots([{ path: root, source: 'user-dsh', label: '用户', writable: true }])
  assert.equal(scan.skills.length, 0)
})

test('a symlinked skill cannot be toggled outside its root', () => {
  const home = tempHome()
  const root = join(home, 'skills')
  mkdirSync(root, { recursive: true })
  const outside = join(home, 'outside')
  writeSkill(outside, 'alpha')
  symlinkSync(join(outside, 'alpha'), join(root, 'alpha'), process.platform === 'win32' ? 'junction' : 'dir')

  const scan = scanRoots([{ path: root, source: 'user-dsh', label: '用户', writable: true }])
  const skill = scan.skills.find((entry) => entry.name === 'alpha')
  assert.ok(skill)
  assert.equal(skill.link, true)
  assert.throws(
    () => toggleSkill(skill, false),
    (error) => error.code === 'READONLY',
  )
  assert.doesNotMatch(readFileSync(join(outside, 'alpha', 'SKILL.md'), 'utf8'), /disable-model-invocation/)
})

test('a filesystem skill outranks a registry row of the same name', () => {
  const existing = { name: 'alpha', source: 'user-dsh' }
  const merged = mergeRegistry([existing], [{ name: 'alpha', description: 'duplicate', source: 'bundled' }])
  assert.equal(merged.length, 1)
  assert.equal(merged[0], existing)
})

test('findProjectRoot walks up to .git', () => {
  const home = tempHome()
  const project = join(home, 'repo')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(project, 'packages', 'app'), { recursive: true })
  assert.equal(findProjectRoot(join(project, 'packages', 'app')), project)
  assert.equal(findProjectRoot(project), project)
})

test('toggling rewrites only disable-model-invocation', () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha', { body: '# Keep\n\nbody line' })
  const scan = scanRoots(rootsFor(home, home))
  const skill = scan.skills.find((entry) => entry.name === 'alpha')
  assert.equal(skill.modelInvocable, true)

  toggleSkill(skill, false)
  const disabled = readFileSync(skill.path, 'utf8')
  assert.match(disabled, /disable-model-invocation: true/)
  assert.match(disabled, /# Keep\n\nbody line/)

  toggleSkill(skill, true)
  const enabled = readFileSync(skill.path, 'utf8')
  assert.doesNotMatch(enabled, /disable-model-invocation/)
})

test('read-only registry rows cannot be toggled', () => {
  const skill = { name: 'bundled', readOnly: true, path: undefined, rootPath: undefined }
  assert.throws(() => toggleSkill(skill, false), /没有可写的本地文件/)
})

test('create writes a valid SKILL.md and refuses to overwrite', () => {
  const home = tempHome()
  const result = createSkill({
    name: 'new-skill',
    description: 'does one thing',
    whenToUse: 'when testing',
    content: '# Steps',
    scope: 'user',
    cwd: home,
    dshHome: home,
  })
  assert.ok(existsSync(result.path))
  const text = readFileSync(result.path, 'utf8')
  assert.match(text, /name: new-skill/)
  assert.match(text, /# Steps/)
  assert.throws(
    () =>
      createSkill({
        name: 'new-skill',
        description: 'again',
        scope: 'user',
        cwd: home,
        dshHome: home,
      }),
    /同名技能已存在/,
  )
})

test('create rejects invalid names, empty descriptions and oversized bodies', () => {
  const home = tempHome()
  assert.throws(() => createSkill({ name: 'Bad Name', description: 'x', dshHome: home }), /kebab-case/)
  assert.throws(() => createSkill({ name: 'ok', description: '', dshHome: home }), /描述不能为空/)
  assert.throws(
    () => createSkill({ name: 'ok', description: 'x', content: 'x'.repeat(65 * 1024), dshHome: home }),
    /64KB/,
  )
})

test('archive moves a skill into its root .trash and restore puts it back', () => {
  const home = tempHome()
  writeSkill(join(home, 'skills'), 'alpha')
  const roots = rootsFor(home, home)
  const skill = scanRoots(roots).skills.find((entry) => entry.name === 'alpha')

  const archived = archiveSkill(skill, Date.now())
  assert.equal(existsSync(skill.directory), false)
  assert.ok(existsSync(join(skill.rootPath, '.trash', archived.entry)))

  const trash = listTrash(roots)
  assert.equal(trash.length, 1)
  assert.equal(trash[0].name, 'alpha')
  assert.equal(trash[0].source, 'user-dsh')

  const restored = restoreTrash(trash[0].id, roots)
  assert.equal(restored.name, 'alpha')
  assert.ok(existsSync(join(home, 'skills', 'alpha', 'SKILL.md')))
  assert.equal(listTrash(roots).length, 0)
})

test('archive also works for a flat .md skill', () => {
  const home = tempHome()
  writeFlatSkill(join(home, 'skills'), 'flat-skill')
  const roots = rootsFor(home, home)
  const skill = scanRoots(roots).skills.find((entry) => entry.name === 'flat-skill')
  const archived = archiveSkill(skill, Date.now())
  assert.match(archived.entry, /flat-skill\.md$/)
  const trash = listTrash(roots)
  assert.equal(trash[0].kind, 'file')
  restoreTrash(trash[0].id, roots)
  assert.ok(existsSync(join(home, 'skills', 'flat-skill.md')))
})

test('listTrash ignores unknown directory entries and foreign ids', () => {
  const home = tempHome()
  mkdirSync(join(home, 'skills', '.trash', 'not-a-trash-entry'), { recursive: true })
  const roots = rootsFor(home, home)
  assert.equal(listTrash(roots).length, 0)
  assert.throws(() => restoreTrash('bogus', roots), /回收站条目不存在/)
})

test('findSkill refuses a stale path and reports an unknown name', () => {
  const skills = [{ name: 'alpha', path: 'D:\\one\\SKILL.md' }]
  assert.equal(findSkill(skills, 'missing').error !== undefined, true)
  assert.equal(findSkill(skills, 'alpha', 'D:\\two\\SKILL.md').error !== undefined, true)
  assert.equal(findSkill(skills, 'alpha', 'D:\\one\\SKILL.md').skill.name, 'alpha')
})
