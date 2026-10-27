// Zero-dependency reader/writer for the SKILL.md frontmatter DSH already uses.
//
// The official filesystem provider parses YAML with a full parser; this module
// only needs the handful of scalar keys the radar reads or writes, plus exact
// preservation of everything else. It never re-serialises the document: toggling
// a switch removes one top-level line or appends one, so descriptions, block
// scalars and the instruction body survive byte-for-byte.

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Return whether a string is a valid public skill name (kebab-case). */
export function isSkillName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && SKILL_NAME.test(name)
}

function parseScalar(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch (error) {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/**
 * Parse a leading `---` frontmatter block.
 * @param raw - complete SKILL.md text.
 * @returns data, body, line ending, and BOM presence, or undefined without frontmatter.
 */
export function parseFrontmatter(raw) {
  if (typeof raw !== 'string') return undefined
  const bom = raw.charCodeAt(0) === 0xfeff
  const text = bom ? raw.slice(1) : raw
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] === undefined || lines[0].trim() !== '---') return undefined

  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      close = index
      break
    }
  }
  if (close < 0) return undefined

  const data = {}
  let index = 1
  while (index < close) {
    const line = lines[index]
    if (line.trim() === '' || line.trim().startsWith('#') || /^[ \t]/.test(line)) {
      index += 1
      continue
    }
    const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line)
    if (match === null) {
      index += 1
      continue
    }
    const key = match[1]
    const rest = match[2].trim()

    if (/^[|>][+-]?$/.test(rest)) {
      const folded = rest[0] === '>'
      const block = []
      let minIndent = Infinity
      index += 1
      while (index < close) {
        const current = lines[index]
        if (current.trim() === '') {
          block.push('')
          index += 1
          continue
        }
        const indent = /^[ \t]*/.exec(current)[0].length
        if (indent === 0) break
        if (indent < minIndent) minIndent = indent
        block.push(current)
        index += 1
      }
      const dedented = block.map((line) => (line.trim() === '' ? '' : line.slice(Math.min(minIndent, line.length))))
      data[key] = folded
        ? dedented.join('\n').replace(/\n(?!\n)/g, ' ').trim()
        : dedented.join('\n').replace(/\s+$/, '')
      continue
    }

    data[key] = parseScalar(rest)
    index += 1
  }

  return {
    data,
    body: lines.slice(close + 1).join('\n'),
    eol,
    bom,
  }
}

/** Read a YAML-ish boolean frontmatter value. */
export function frontmatterBoolean(data, key) {
  if (data === undefined || data === null || !Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value === 'string') {
    switch (value.trim().toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
      case '1':
        return true
      case 'false':
      case 'no':
      case 'off':
      case '0':
        return false
      default:
        return undefined
    }
  }
  return undefined
}

function normalizeText(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

function yamlValue(value) {
  const text = String(value)
  if (text.length > 0 && /^[A-Za-z0-9_.\/-]+$/.test(text)) return text
  return JSON.stringify(text)
}

/**
 * Flip `disable-model-invocation` while leaving every other byte alone.
 * Enabling removes the key (absence means model-invocable); disabling appends
 * the canonical key just before the closing fence.
 * @param raw - complete SKILL.md text with frontmatter.
 * @param enabled - whether the model may invoke the skill.
 * @returns new document text.
 */
export function setModelInvocable(raw, enabled) {
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) throw new Error('SKILL.md has no frontmatter')

  const bom = parsed.bom
  const eol = parsed.eol
  const text = bom ? raw.slice(1) : raw
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      close = index
      break
    }
  }
  if (close < 0) throw new Error('SKILL.md frontmatter is not closed')

  const kept = []
  for (let index = 1; index < close; index += 1) {
    if (/^disable-model-invocation\s*:/.test(lines[index])) continue
    kept.push(lines[index])
  }
  if (enabled !== true) kept.push('disable-model-invocation: true')

  const next = [lines[0], ...kept, lines[close], ...lines.slice(close + 1)].join('\n')
  return (bom ? '\ufeff' : '') + next.replace(/\n/g, eol)
}

/** Build a new SKILL.md from the create form. */
export function renderSkillDocument(input) {
  const name = String(input.name || '').trim()
  const description = normalizeText(input.description, 500)
  const whenToUse = normalizeText(input.whenToUse, 500)
  const body = typeof input.content === 'string' ? input.content.replace(/\r\n/g, '\n').trim() : ''
  if (!isSkillName(name)) throw new Error('skill name must be kebab-case')
  if (description.length === 0) throw new Error('description is required')

  const lines = ['---', 'name: ' + yamlValue(name), 'description: ' + yamlValue(description)]
  if (whenToUse.length > 0) lines.push('whenToUse: ' + yamlValue(whenToUse))
  lines.push('---', '')
  if (body.length > 0) lines.push(body)
  else lines.push('# ' + name, '', '（在这里写这个技能的完整做法。）')
  return lines.join('\n').replace(/\n*$/, '\n')
}
