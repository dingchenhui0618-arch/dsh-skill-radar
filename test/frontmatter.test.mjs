import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  frontmatterBoolean,
  isSkillName,
  parseFrontmatter,
  renderSkillDocument,
  setModelInvocable,
} from '../src/frontmatter.js'

test('parses name, description, whenToUse and body', () => {
  const parsed = parseFrontmatter(
    ['---', 'name: release-checklist', 'description: Check the release', 'whenToUse: before a tag', '---', '', '# Body', 'more'].join('\n'),
  )
  assert.equal(parsed.data.name, 'release-checklist')
  assert.equal(parsed.data.description, 'Check the release')
  assert.equal(parsed.data.whenToUse, 'before a tag')
  assert.equal(parsed.body, '\n# Body\nmore')
})

test('parses quoted scalars and folded block scalars', () => {
  const parsed = parseFrontmatter(
    ['---', 'name: demo', 'description: "a: quoted # value"', 'whenToUse: >', '  first line', '  second line', '---', '', 'body'].join('\n'),
  )
  assert.equal(parsed.data.description, 'a: quoted # value')
  assert.equal(parsed.data.whenToUse, 'first line second line')
})

test('rejects documents without frontmatter', () => {
  assert.equal(parseFrontmatter('# just markdown'), undefined)
  assert.equal(parseFrontmatter('---\nname: demo\n'), undefined)
})

test('reads the canonical invocation booleans and their spellings', () => {
  assert.equal(frontmatterBoolean({ 'disable-model-invocation': true }, 'disable-model-invocation'), true)
  assert.equal(frontmatterBoolean({ 'disable-model-invocation': 'yes' }, 'disable-model-invocation'), true)
  assert.equal(frontmatterBoolean({ 'user-invocable': 'off' }, 'user-invocable'), false)
  assert.equal(frontmatterBoolean({}, 'user-invocable'), undefined)
})

test('validateSkillName enforces kebab-case', () => {
  assert.equal(isSkillName('release-checklist'), true)
  assert.equal(isSkillName('a1-b2'), true)
  assert.equal(isSkillName('Release'), false)
  assert.equal(isSkillName('release--checklist'), false)
  assert.equal(isSkillName('-release'), false)
  assert.equal(isSkillName(''), false)
})

test('disabling appends one key and leaves every other line untouched', () => {
  const raw = [
    '---',
    'name: demo',
    'description: "keep me"',
    'whenToUse: >',
    '  folded text',
    '---',
    '',
    '# Body',
    'do not touch',
    '',
  ].join('\n')
  const disabled = setModelInvocable(raw, false)
  assert.match(disabled, /disable-model-invocation: true/)
  assert.match(disabled, /description: "keep me"/)
  assert.match(disabled, /whenToUse: >\n  folded text/)
  assert.ok(disabled.endsWith('# Body\ndo not touch\n'))

  const enabled = setModelInvocable(disabled, true)
  assert.equal(enabled, raw)
})

test('enabling removes a false value as well as a true one', () => {
  const raw = ['---', 'name: demo', 'description: d', 'disable-model-invocation: false', '---', 'body'].join('\n')
  const enabled = setModelInvocable(raw, true)
  assert.doesNotMatch(enabled, /disable-model-invocation/)
})

test('preserves CRLF line endings', () => {
  const raw = ['---', 'name: demo', 'description: d', '---', '', 'body'].join('\r\n')
  const disabled = setModelInvocable(raw, false)
  assert.match(disabled, /\r\n/)
  assert.ok(disabled.includes('disable-model-invocation: true\r\n'))
})

test('renderSkillDocument round-trips through the parser', () => {
  const document = renderSkillDocument({
    name: 'demo-skill',
    description: 'a description: with colon',
    whenToUse: 'when testing',
    content: '# Steps\n\n1. do it',
  })
  const parsed = parseFrontmatter(document)
  assert.equal(parsed.data.name, 'demo-skill')
  assert.equal(parsed.data.description, 'a description: with colon')
  assert.equal(parsed.data.whenToUse, 'when testing')
  assert.match(parsed.body, /# Steps/)
})

test('renderSkillDocument rejects invalid input', () => {
  assert.throws(() => renderSkillDocument({ name: 'Bad Name', description: 'x' }), /kebab-case/)
  assert.throws(() => renderSkillDocument({ name: 'ok', description: '' }), /description/)
})
