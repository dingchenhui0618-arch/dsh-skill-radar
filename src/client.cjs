// Client half of dsh-skill-radar: the 技能雷达 tab in the conversation view.
//
// The host is the single source of truth. This side owns one shared poller,
// renders the ranked list, and posts every mutation back to /dsh-skill-radar.
// Must stay CommonJS: the build wraps this in window.__ModuleLoader__.load().

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

const API = '/dsh-skill-radar'
const POLL_MS = 2500
const STORAGE_KEY = 'dsh-skill-radar.prefs'

let snap = { data: null, error: '', at: 0 }
const listeners = new Set()
let timer = null
let inFlight = false
let activeCwd = ''

function withCwd(url) {
  if (activeCwd.length === 0) return url
  return url + '?cwd=' + encodeURIComponent(activeCwd)
}

function emit() {
  Array.from(listeners).forEach(function (listener) {
    try {
      listener(snap)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-skill-radar] listener failed', error)
    }
  })
}

function refresh() {
  if (inFlight) return
  inFlight = true
  fetch(withCwd(API + '/state'), { headers: { accept: 'application/json' } })
    .then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok || data.ok === false) throw new Error((data && data.error) || 'HTTP ' + response.status)
        return data
      })
    })
    .then(function (data) {
      snap = { data: data, error: '', at: Date.now() }
      emit()
    })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), at: Date.now() }
      emit()
    })
    .finally(function () {
      inFlight = false
    })
}

function subscribe(listener) {
  listeners.add(listener)
  if (timer === null) {
    refresh()
    timer = setInterval(refresh, POLL_MS)
  }
  listener(snap)
  return function () {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function post(method, body) {
  return fetch(withCwd(API + '/' + method), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-skill-radar': '1' },
    body: JSON.stringify(body || {}),
  }).then(function (response) {
    return response.json().then(
      function (data) {
        if (!response.ok || data.ok === false) {
          throw new Error((data && data.error) || '请求失败（HTTP ' + response.status + '）')
        }
        return data
      },
      function () {
        throw new Error('请求失败（HTTP ' + response.status + '）')
      },
    )
  })
}

function readPrefs() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { view: 'hits' }
    const parsed = JSON.parse(raw)
    return { view: parsed && parsed.view === 'source' ? 'source' : 'hits' }
  } catch (error) {
    return { view: 'hits' }
  }
}

function savePrefs(prefs) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch (error) {
    // A browser that refuses storage just loses the preference.
  }
}

function pad(value) {
  return value < 10 ? '0' + value : String(value)
}

function formatExact(at) {
  const date = new Date(at)
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds())
  )
}

function formatRelative(at, now) {
  if (!Number.isFinite(at) || at <= 0) return '—'
  const diff = Math.max(0, now - at)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前'
  const days = Math.floor(diff / 86_400_000)
  if (days < 7) return days + ' 天前'
  const date = new Date(at)
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function sessionLabel(hit) {
  if (hit === null || hit === undefined) return '—'
  if (typeof hit.title === 'string' && hit.title.length > 0) return hit.title
  if (typeof hit.session === 'string' && hit.session.length > 0) return '会话 ' + hit.session.slice(0, 8)
  return '未知会话'
}

function Stat(props) {
  return h(
    'div',
    { className: 'sr-stat' + (props.tone ? ' ' + props.tone : '') },
    h('b', null, String(props.value)),
    h('span', null, props.label),
  )
}

function Spark(props) {
  const daily = Array.isArray(props.daily) ? props.daily : []
  const max = Math.max(1, ...daily)
  return h(
    'div',
    { className: 'sr-bars', title: props.title || '', 'aria-hidden': 'true' },
    daily.map(function (value, index) {
      const height = value === 0 ? 3 : 5 + Math.round((value / max) * 10)
      return h('span', {
        key: index,
        className: 'sr-bar' + (value === 0 ? ' zero' : ''),
        style: { height: height + 'px' },
      })
    }),
  )
}

function Switch(props) {
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': props.checked ? 'true' : 'false',
      'aria-label': props.label,
      className: 'sr-switch',
      disabled: props.disabled,
      title: props.title,
      onClick: props.onClick,
    },
    h('span', { className: 'sr-sr-only' }, props.checked ? '已启用' : '已停用'),
  )
}

function HitList(props) {
  const skill = props.skill
  const hits = Array.isArray(skill.recentHits) ? skill.recentHits : []
  const older = skill.hitsOlder > 0 ? '，另有 ' + skill.hitsOlder + ' 次在 7 天窗口外' : ''
  return h(
    'div',
    { className: 'sr-detail-body' },
    h(
      'div',
      { className: 'sr-detail-head' },
      h('span', null, '命中记录 · 最近 ' + hits.length + ' 次'),
      h('span', null, '总计 ' + skill.hitsTotal + ' 次' + older),
    ),
    hits.length === 0
      ? h(
          'div',
          { className: 'sr-detail-empty' },
          '还没有命中记录。模型调用 skill 工具，或在输入框里用 /' + skill.name + ' 触发一次。',
        )
      : h(
          'div',
          null,
          hits.map(function (hit, index) {
            return h(
              'div',
              { className: 'sr-hit', key: String(hit.at) + '-' + index },
              h('span', { className: 'sr-hit-time' }, formatExact(hit.at)),
              h('span', { className: 'sr-hit-session', title: hit.session || '' }, sessionLabel(hit)),
              h('span', { className: 'sr-hit-trigger' }, hit.trigger || hit.name),
              h('span', { className: 'sr-hit-prompt', title: hit.prompt || '' }, hit.prompt || '—'),
            )
          }),
        ),
  )
}

function SkillRow(props) {
  const skill = props.skill
  const stale = skill.stale === true
  const last = skill.lastHit
  const readOnly = skill.readOnly === true
  const expanded = props.expanded === skill.name
  const armed = props.armed === skill.name
  const busy = props.busy === 'toggle:' + skill.name || props.busy === 'archive:' + skill.name

  return h(
    'div',
    { className: 'sr-item' + (stale ? ' stale' : '') },
    h(
      'div',
      { className: 'sr-cols sr-row' },
      h(
        'div',
        { className: 'sr-skill' },
        h(
          'div',
          { className: 'sr-name' },
          h('span', { className: 'sr-name-text' }, skill.name),
          readOnly ? h('span', { className: 'sr-mini-chip', title: '由插件或注册表提供，没有可写的本地文件' }, '只读') : null,
          skill.link ? h('span', { className: 'sr-mini-chip' }, '软链接') : null,
        ),
        h('div', { className: 'sr-desc', title: skill.description }, skill.description),
      ),
      h('div', { className: 'sr-source' }, h('span', { className: 'sr-chip' }, skill.sourceLabel)),
      h(
        'div',
        { className: 'sr-toggle' },
        h(Switch, {
          checked: skill.modelInvocable,
          disabled: readOnly || busy,
          label: '模型调用 ' + skill.name,
          title: readOnly ? '插件提供的技能无法从本地文件启停' : skill.modelInvocable ? '点击停用模型调用' : '点击启用模型调用',
          onClick: readOnly ? undefined : function () {
            props.onToggle(skill)
          },
        }),
      ),
      h(
        'div',
        { className: 'sr-hitcell' },
        h(
          'div',
          { className: 'sr-hit-top' },
          h(
            'button',
            {
              type: 'button',
              className: 'sr-count',
              'aria-expanded': expanded ? 'true' : 'false',
              title: '展开命中记录',
              onClick: function () {
                props.onExpand(expanded ? null : skill.name)
              },
            },
            h('b', null, String(skill.hits7)),
            h('small', null, '次'),
          ),
          h(Spark, {
            daily: skill.daily,
            title: (props.dailyLabels || []).map(function (label, index) {
              return label + ' ' + (skill.daily[index] || 0) + ' 次'
            }).join(' · '),
          }),
        ),
        stale
          ? h('span', { className: 'sr-stale-badge', title: '最近 ' + props.windowDays + ' 天没有命中' }, '建议归档')
          : null,
      ),
      h(
        'div',
        { className: 'sr-last' },
        last === null
          ? h('span', { className: 'sr-muted' }, '从未命中')
          : h(
              React.Fragment,
              null,
              h('span', { className: 'sr-last-time' }, formatRelative(last.at, props.now)),
              h(
                'span',
                { className: 'sr-last-meta', title: (last.prompt || '') + (last.session ? ' · ' + last.session : '') },
                sessionLabel(last) + ' · ' + (last.trigger || last.name),
              ),
            ),
      ),
      h(
        'div',
        { className: 'sr-acts' },
        readOnly
          ? h('span', { className: 'sr-muted sr-act-note' }, '无本地文件')
          : armed
            ? h(
                React.Fragment,
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sr-btn tiny danger-solid',
                    disabled: busy,
                    onClick: function () {
                      props.onArchive(skill, true)
                    },
                  },
                  busy ? '归档中…' : '确认归档',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sr-btn tiny',
                    disabled: busy,
                    onClick: function () {
                      props.onArchive(skill, false)
                    },
                  },
                  '取消',
                ),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'sr-btn tiny danger',
                  disabled: busy,
                  title: '移入该技能根目录下的 .trash，可恢复',
                  onClick: function () {
                    props.onArchive(skill, null)
                  },
                },
                '归档',
              ),
      ),
    ),
    expanded ? h('div', { className: 'sr-detail' }, h(HitList, { skill: skill })) : null,
  )
}

function CreateForm(props) {
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [whenToUse, setWhenToUse] = React.useState('')
  const [content, setContent] = React.useState('')
  const [scope, setScope] = React.useState('user')
  const [error, setError] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  function submit(event) {
    event.preventDefault()
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.trim())) {
      setError('技能名必须是 kebab-case：小写字母、数字和连字符')
      return
    }
    if (description.trim().length === 0) {
      setError('描述不能为空')
      return
    }
    setError('')
    setSaving(true)
    props
      .onSubmit({
        name: name.trim(),
        description: description.trim(),
        whenToUse: whenToUse.trim(),
        content: content,
        scope: scope,
      })
      .then(function () {
        setName('')
        setDescription('')
        setWhenToUse('')
        setContent('')
        setSaving(false)
      })
      .catch(function (failure) {
        setSaving(false)
        setError(String((failure && failure.message) || failure))
      })
  }

  return h(
    'form',
    { className: 'sr-form', onSubmit: submit },
    h(
      'div',
      { className: 'sr-form-head' },
      h('div', null, h('h4', null, '新建技能'), h('p', null, '写入用户级或当前项目的技能根，立刻出现在列表里。')),
      h(
        'button',
        { type: 'button', className: 'sr-btn tiny', onClick: props.onClose },
        '收起',
      ),
    ),
    h(
      'div',
      { className: 'sr-form-grid' },
      h(
        'label',
        { className: 'sr-field' },
        h('span', { className: 'sr-label' }, '名称'),
        h('input', {
          className: 'sr-input',
          value: name,
          placeholder: '例如 release-checklist',
          spellCheck: 'false',
          onChange: function (event) {
            setName(event.target.value)
          },
        }),
        h('span', { className: 'sr-hint' }, 'kebab-case，创建后不可改名'),
      ),
      h(
        'label',
        { className: 'sr-field' },
        h('span', { className: 'sr-label' }, '写入位置'),
        h(
          'select',
          {
            className: 'sr-input',
            value: scope,
            onChange: function (event) {
              setScope(event.target.value)
            },
          },
          h('option', { value: 'user' }, '用户级 · ~/.dsh/skills'),
          h('option', { value: 'project' }, '项目级 · .dsh/skills'),
        ),
        h('span', { className: 'sr-hint' }, props.cwd ? '项目根：' + props.cwd : '按当前工作目录解析项目根'),
      ),
      h(
        'label',
        { className: 'sr-field wide' },
        h('span', { className: 'sr-label' }, '描述'),
        h('input', {
          className: 'sr-input',
          value: description,
          placeholder: '一句话说明这个技能什么时候该被调用',
          onChange: function (event) {
            setDescription(event.target.value)
          },
        }),
      ),
      h(
        'label',
        { className: 'sr-field wide' },
        h('span', { className: 'sr-label' }, '适用场景（可选）'),
        h('input', {
          className: 'sr-input',
          value: whenToUse,
          placeholder: '例如：发布前检查版本号、变更日志和 tag',
          onChange: function (event) {
            setWhenToUse(event.target.value)
          },
        }),
      ),
      h(
        'label',
        { className: 'sr-field wide' },
        h('span', { className: 'sr-label' }, '正文（可选）'),
        h('textarea', {
          className: 'sr-textarea',
          value: content,
          rows: 5,
          placeholder: 'Markdown 指令正文；留空会生成一个待填写的骨架。',
          onChange: function (event) {
            setContent(event.target.value)
          },
        }),
      ),
    ),
    error ? h('div', { className: 'sr-form-error' }, error) : null,
    h(
      'div',
      { className: 'sr-form-actions' },
      h('span', { className: 'sr-hint' }, '同名技能不会被覆盖；正文上限 64KB。'),
      h(
        'button',
        { type: 'button', className: 'sr-btn', onClick: props.onClose, disabled: saving },
        '取消',
      ),
      h(
        'button',
        { type: 'submit', className: 'sr-btn primary', disabled: saving },
        saving ? '创建中…' : '创建技能',
      ),
    ),
  )
}

function SkillRadar(props) {
  // The panel is mounted per session; the host must scan that session's project,
  // not whichever cwd happened to be the last hit in the ledger.
  const sessionCwd = props.useSessions(function (snapshot) {
    if (props.sessionId === undefined || snapshot === undefined || snapshot.byId === undefined) return undefined
    const session = snapshot.byId[props.sessionId]
    return session === undefined ? undefined : session.cwd
  })
  if (typeof sessionCwd === 'string' && sessionCwd.length > 0 && sessionCwd !== activeCwd) {
    activeCwd = sessionCwd
  }

  const [state, setState] = React.useState(snap)
  const [prefs, setPrefs] = React.useState(readPrefs)
  const [query, setQuery] = React.useState('')
  const [staleOnly, setStaleOnly] = React.useState(false)
  const [expanded, setExpanded] = React.useState(null)
  const [armed, setArmed] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const [formOpen, setFormOpen] = React.useState(false)
  const [notice, setNotice] = React.useState(null)
  const [clearArmed, setClearArmed] = React.useState(false)

  React.useEffect(function () {
    return subscribe(setState)
  }, [])

  React.useEffect(
    function () {
      if (notice === null) return undefined
      const handle = setTimeout(function () {
        setNotice(null)
      }, 3600)
      return function () {
        clearTimeout(handle)
      }
    },
    [notice],
  )

  React.useEffect(
    function () {
      savePrefs(prefs)
    },
    [prefs],
  )

  const data = state.data
  const now = data && Number.isFinite(data.now) ? data.now : Date.now()
  const windowDays = data && Number.isFinite(data.windowDays) ? data.windowDays : 7
  const allSkills = data && Array.isArray(data.skills) ? data.skills : []
  const trash = data && Array.isArray(data.trash) ? data.trash : []
  const stats = (data && data.stats) || { skills: 0, hits7: 0, stale: 0, trash: 0, sessions: 0 }

  const visible = allSkills.filter(function (skill) {
    if (staleOnly && !skill.stale) return false
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return true
    return skill.name.toLowerCase().includes(needle) || String(skill.description || '').toLowerCase().includes(needle)
  })

  const groups = React.useMemo(
    function () {
      if (prefs.view === 'hits') return [{ key: 'all', label: '', skills: visible }]
      const map = new Map()
      for (const skill of visible) {
        let group = map.get(skill.group)
        if (group === undefined) {
          group = { key: skill.group, label: skill.group, order: skill.groupOrder, skills: [] }
          map.set(skill.group, group)
        }
        group.skills.push(skill)
      }
      return Array.from(map.values()).sort(function (a, b) {
        return a.order - b.order
      })
    },
    [prefs.view, visible],
  )

  function done(text) {
    setNotice({ tone: 'ok', text: text })
    refresh()
  }

  function failed(error) {
    setNotice({ tone: 'err', text: String((error && error.message) || error) })
  }

  function toggle(skill) {
    setBusy('toggle:' + skill.name)
    post('toggle', { name: skill.name, path: skill.path, enabled: !skill.modelInvocable })
      .then(function () {
        done((skill.modelInvocable ? '已停用 ' : '已启用 ') + skill.name + ' 的模型调用')
      })
      .catch(failed)
      .finally(function () {
        setBusy('')
      })
  }

  function archive(skill, confirmed) {
    if (confirmed !== true) {
      setArmed(confirmed === false ? null : skill.name)
      return
    }
    setBusy('archive:' + skill.name)
    post('archive', { name: skill.name, path: skill.path })
      .then(function () {
        setArmed(null)
        setExpanded(null)
        done('已把 ' + skill.name + ' 移入回收站，可随时恢复')
      })
      .catch(failed)
      .finally(function () {
        setBusy('')
      })
  }

  function restore(item) {
    setBusy('restore:' + item.id)
    post('restore', { id: item.id })
      .then(function () {
        done('已恢复 ' + item.name)
      })
      .catch(failed)
      .finally(function () {
        setBusy('')
      })
  }

  function create(input) {
    return post('create', input).then(function (result) {
      setFormOpen(false)
      done('已创建 ' + result.name + ' · ' + result.path)
      return result
    })
  }

  function clearHits() {
    if (!clearArmed) {
      setClearArmed(true)
      return
    }
    setClearArmed(false)
    post('clear-hits', { confirm: true })
      .then(function () {
        done('命中记录已清空')
      })
      .catch(failed)
  }

  return h(
    'div',
    { className: 'sr-root' },
    h(
      'div',
      { className: 'sr-inner' },
      h(
        'div',
        { className: 'sr-head' },
        h('span', { className: 'sr-mark', 'aria-hidden': 'true' }),
        h(
          'div',
          { className: 'sr-heading' },
          h('h3', null, '技能雷达'),
          h('p', null, '用命中记录决定留哪一个：按最近 ' + windowDays + ' 天的调用排序，零命中的建议归档。'),
        ),
        h(
          'div',
          { className: 'sr-head-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'sr-btn',
              onClick: refresh,
              disabled: state.error.length > 0 && data === null,
            },
            '刷新',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'sr-btn primary',
              onClick: function () {
                setFormOpen(!formOpen)
              },
            },
            formOpen ? '收起表单' : '新建技能',
          ),
        ),
      ),

      h(
        'div',
        { className: 'sr-stats' },
        h(Stat, { label: '已加载技能', value: stats.skills }),
        h(Stat, { label: windowDays + ' 天命中', value: stats.hits7, tone: 'good' }),
        h(Stat, { label: '建议归档', value: stats.stale, tone: stats.stale > 0 ? 'warn' : '' }),
        h(Stat, { label: '回收站', value: stats.trash }),
      ),
      h(
        'div',
        { className: 'sr-note' },
        data
          ? '本地命中账本 · ' + stats.sessions + ' 个会话在窗口内调用过技能 · 数据只留在这台机器'
          : '正在读取技能目录…',
      ),

      state.error
        ? h(
            'div',
            { className: 'sr-banner err' },
            h('span', null, '与 host 通信失败：' + state.error),
            h('button', { type: 'button', className: 'sr-btn tiny', onClick: refresh }, '重试'),
          )
        : null,
      notice
        ? h(
            'div',
            { className: 'sr-banner ' + notice.tone },
            h('span', null, notice.text),
            h(
              'button',
              {
                type: 'button',
                className: 'sr-btn tiny',
                onClick: function () {
                  setNotice(null)
                },
              },
              '关闭',
            ),
          )
        : null,

      formOpen
        ? h(CreateForm, { onSubmit: create, onClose: function () { setFormOpen(false) }, cwd: data && data.cwd })
        : null,

      h(
        'div',
        { className: 'sr-toolbar' },
        h(
          'div',
          { className: 'sr-seg', role: 'group', 'aria-label': '排序方式' },
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': prefs.view === 'hits' ? 'true' : 'false',
              onClick: function () {
                setPrefs({ view: 'hits' })
              },
            },
            '按命中排序',
          ),
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': prefs.view === 'source' ? 'true' : 'false',
              onClick: function () {
                setPrefs({ view: 'source' })
              },
            },
            '按来源分组',
          ),
        ),
        h(
          'label',
          { className: 'sr-check' },
          h('input', {
            type: 'checkbox',
            checked: staleOnly,
            onChange: function (event) {
              setStaleOnly(event.target.checked)
            },
          }),
          '只看建议归档',
        ),
        h('div', { className: 'sr-spacer' }),
        h('input', {
          className: 'sr-input sr-search',
          type: 'search',
          value: query,
          placeholder: '搜索名称或描述',
          'aria-label': '搜索技能',
          onChange: function (event) {
            setQuery(event.target.value)
          },
        }),
        stats.hits7 > 0
          ? h(
              'button',
              { type: 'button', className: 'sr-btn tiny', onClick: clearHits, title: '清空本机命中账本' },
              clearArmed ? '确认清空' : '清空命中',
            )
          : null,
      ),

      allSkills.length === 0 && data
        ? h(
            'div',
            { className: 'sr-empty' },
            h('b', null, '没有扫描到技能'),
            h(
              'span',
              null,
              '技能根为空。可以在上方新建，或把 SKILL.md 放进 ~/.dsh/skills、项目 .dsh/skills。',
            ),
          )
        : h(
            'div',
            { className: 'sr-list' },
            h(
              'div',
              { className: 'sr-cols sr-thead' },
              h('span', null, '技能'),
              h('span', null, '来源'),
              h('span', null, '模型调用'),
              h('span', null, '命中记录'),
              h('span', null, '最近命中'),
              h('span', null, '操作'),
            ),
            groups.map(function (group) {
              return h(
                React.Fragment,
                { key: group.key },
                group.label
                  ? h(
                      'div',
                      { className: 'sr-group' },
                      h('span', null, group.label),
                      h('span', { className: 'sr-group-count' }, group.skills.length + ' 个'),
                    )
                  : null,
                group.skills.map(function (skill) {
                  return h(SkillRow, {
                    key: skill.name,
                    skill: skill,
                    now: now,
                    windowDays: windowDays,
                    dailyLabels: data && data.dailyLabels,
                    expanded: expanded,
                    armed: armed,
                    busy: busy,
                    onExpand: setExpanded,
                    onToggle: toggle,
                    onArchive: archive,
                  })
                }),
              )
            }),
            visible.length === 0
              ? h(
                  'div',
                  { className: 'sr-filtered' },
                  staleOnly
                    ? '没有建议归档的技能——窗口内所有技能都命中过。'
                    : '没有匹配的技能。',
                )
              : null,
          ),

      h(
        'div',
        { className: 'sr-trash' },
        h(
          'div',
          { className: 'sr-section-head' },
          h('h4', null, '回收站'),
          h('span', { className: 'sr-muted' }, '归档进入各技能根下的 .trash，恢复后回到原位置'),
        ),
        trash.length === 0
          ? h('div', { className: 'sr-trash-empty' }, '回收站是空的。')
          : h(
              'div',
              { className: 'sr-trash-list' },
              trash.map(function (item) {
                const restoring = busy === 'restore:' + item.id
                return h(
                  'div',
                  { className: 'sr-trash-row', key: item.id },
                  h(
                    'div',
                    { className: 'sr-trash-main' },
                    h('div', { className: 'sr-name' }, item.name),
                    h(
                      'div',
                      { className: 'sr-trash-meta' },
                      item.sourceShort + ' · 归档于 ' + formatExact(item.at),
                    ),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sr-btn tiny good',
                      disabled: restoring,
                      onClick: function () {
                        restore(item)
                      },
                    },
                    restoring ? '恢复中…' : '恢复',
                  ),
                )
              }),
            ),
      ),

      h(
        'div',
        { className: 'sr-foot' },
        '命中只记录本插件加载之后的调用；更早的历史不会补记。归档不删除文件，恢复走同一个 .trash 路径。',
      ),
    ),
  )
}

function apply(ctx) {
  // The shared poll and the injected stylesheet both own explicit teardown:
  // dsh can unload a plugin while the conversation view stays mounted.
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      inFlight = false
      snap = { data: null, error: '', at: 0 }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-skill-radar'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () {
      style.remove()
    }
  })

  // A changed slot contract must degrade this panel, not abort the client boot.
  ctx.slots.inject('conversation.view', function () {
    let disposeView
    try {
      disposeView = ctx.slots.register(
        { name: 'conversation.view', id: 'skill-radar', order: 40, label: '技能雷达' },
        SkillRadar,
      )
    } catch (error) {
      disposeView = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-skill-radar] could not register the 技能雷达 view; hit recording still runs on the host', error)
      }
    }
    return typeof disposeView === 'function' ? disposeView : function () {}
  })
}

module.exports = {
  name: 'dsh-skill-radar',
  inject: ['slots'],
  apply: apply,
}
