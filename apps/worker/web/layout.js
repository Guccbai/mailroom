// Part of the Mailroom web app. See app.js.

import { route, start } from './app.js'
import { showShortcuts } from './keys.js'
import {
  app,
  h,
  icon,
  mark,
  parseRoute,
  readPref,
  request,
  setTheme,
  state,
  THEMES,
  withBusy,
  writePref,
} from './lib.js'

/* ---------- login ---------- */

export function renderLogin(message) {
  const error = h('p', { class: 'error', role: 'alert' }, message ?? '')
  const input = h('input', {
    id: 'password',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
  })
  const button = h(
    'button',
    { class: 'btn primary', type: 'submit', style: 'width:100%' },
    '登录',
  )
  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: async (event) => {
        event.preventDefault()
        error.textContent = ''
        await withBusy(button, async () => {
          try {
            await request('/v1/session', {
              method: 'POST',
              body: JSON.stringify({ password: input.value }),
            })
            await start()
          } catch (caught) {
            error.textContent = caught.message
          }
        })
      },
    },
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'password' }, '后台密码'),
      input,
    ),
    button,
    error,
  )
  app.replaceChildren(
    h(
      'div',
      { class: 'login' },
      h(
        'div',
        { class: 'login-card' },
        mark(),
        h('h1', {}, 'Mailroom'),
        h('p', { class: 'hint' }, '你的私人邮箱后台'),
        form,
      ),
    ),
  )
  input.focus()
}

export function renderNoPassword() {
  app.replaceChildren(
    h(
      'div',
      { class: 'login' },
      h(
        'div',
        { class: 'login-card' },
        mark(),
        h('h1', {}, '网页后台未开启'),
        h(
          'p',
          { class: 'hint' },
          '请在 Worker 中设置 MAILROOM_WEB_PASSWORD（至少 12 位），然后刷新此页。',
        ),
        h(
          'pre',
          { class: 'code' },
          'wrangler secret put MAILROOM_WEB_PASSWORD',
        ),
      ),
    ),
  )
}

/* ---------- shell ---------- */

export const FOLDERS = [
  ['inbox', '收件箱', 'inbox'],
  ['sent', '已发送', 'send'],
  ['drafts', '草稿与审批', 'draft'],
  ['archived', '已归档', 'archive'],
  ['spam', '垃圾邮件', 'spam'],
]

const THEME_ICONS = { auto: 'auto', light: 'sun', dark: 'moon' }

function themeButton() {
  const current = readPref('theme', 'auto')
  const index = THEMES.findIndex(([key]) => key === current)
  const [, label] = THEMES[Math.max(index, 0)]
  return h(
    'button',
    {
      class: 'nav-item',
      type: 'button',
      title: `主题：${label}（点击切换）`,
      'aria-label': `主题：${label}`,
      onclick: () => {
        const [next] = THEMES[(index + 1) % THEMES.length]
        setTheme(next)
        route()
      },
    },
    icon(THEME_ICONS[current] ?? 'auto'),
  )
}

function domainGroups() {
  const groups = new Map()
  for (const domain of state.domains)
    groups.set(domain.id, { domain, inboxes: [] })
  for (const inbox of state.inboxes) {
    const group = groups.get(inbox.domainId)
    if (group) group.inboxes.push(inbox)
  }
  return [...groups.values()].filter(
    (group) => group.domain.enabled !== false || group.inboxes.length,
  )
}

function mailboxNav(root) {
  const groups = domainGroups()
  const selectAll = () => setScope('', '')
  const items = [
    h(
      'button',
      {
        class: `nav-item${state.box || state.domain ? '' : ' active'}`,
        type: 'button',
        onclick: selectAll,
      },
      icon('globe'),
      h('span', {}, '全部邮箱'),
    ),
  ]
  for (const { domain, inboxes } of groups) {
    const collapsed = state.collapsed.has(domain.id)
    items.push(
      h(
        'div',
        { class: `nav-group${collapsed ? ' collapsed' : ''}` },
        h(
          'div',
          {
            class: `nav-item domain${state.domain === domain.id && !state.box ? ' active' : ''}`,
            role: 'button',
            tabindex: 0,
            title: domain.domain,
            onclick: () => setScope('', domain.id),
            onkeydown: (event) => {
              if (event.key === 'Enter') setScope('', domain.id)
            },
          },
          h('span', {}, domain.domain),
          inboxes.length
            ? h(
                'button',
                {
                  class: 'nav-toggle',
                  type: 'button',
                  'aria-label': collapsed ? '展开' : '收起',
                  'aria-expanded': collapsed ? 'false' : 'true',
                  onclick: (event) => {
                    event.stopPropagation()
                    if (state.collapsed.has(domain.id))
                      state.collapsed.delete(domain.id)
                    else state.collapsed.add(domain.id)
                    writePref('collapsed', [...state.collapsed].join(','))
                    event.currentTarget
                      .closest('.nav-group')
                      .classList.toggle('collapsed')
                  },
                },
                icon('chevron'),
              )
            : null,
        ),
        inboxes.map((inbox) =>
          h(
            'button',
            {
              class: `nav-item sub${state.box === inbox.id ? ' active' : ''}`,
              type: 'button',
              title: inbox.address,
              onclick: () => setScope(inbox.id, domain.id),
            },
            h('span', {}, inbox.localPart ?? inbox.address),
          ),
        ),
      ),
    )
  }
  root.addEventListener('click', (event) => {
    if (
      event.target.closest('.sidebar .nav-item') &&
      !event.target.closest('.nav-toggle')
    )
      root.classList.remove('nav-open')
  })
  return items
}

export function shell(
  active,
  listPane,
  readPane,
  { wide = false, reading = false } = {},
) {
  const root = h('div', {
    class: `shell${wide ? ' wide' : ''}${reading ? ' reading' : ''}`,
  })
  const nav = h(
    'nav',
    { class: 'sidebar', 'aria-label': '邮箱' },
    h('a', { class: 'brand', href: '#/inbox' }, mark(), 'Mailroom'),
    h(
      'a',
      {
        class: 'btn primary compose-btn',
        href: '#/compose',
        title: '写邮件（c）',
      },
      icon('pen'),
      '写邮件',
    ),
    FOLDERS.map(([key, label, iconName]) =>
      h(
        'a',
        {
          class: `nav-item${active === key ? ' active' : ''}`,
          href: `#/${key}`,
        },
        icon(iconName),
        h('span', {}, label),
        state.counts[key]
          ? h('span', { class: 'nav-count' }, state.counts[key])
          : null,
      ),
    ),
    h('div', { class: 'nav-label' }, '域名与邮箱'),
    mailboxNav(root),
    h(
      'div',
      { class: 'sidebar-foot' },
      h(
        'a',
        {
          class: `nav-item${active === 'settings' ? ' active' : ''}`,
          href: '#/settings',
          title: '设置',
          'aria-label': '设置',
        },
        icon('settings'),
      ),
      themeButton(),
      h(
        'button',
        {
          class: 'nav-item',
          type: 'button',
          title: '键盘快捷键（?）',
          'aria-label': '键盘快捷键',
          onclick: showShortcuts,
        },
        icon('keyboard'),
      ),
    ),
  )
  root.append(
    nav,
    h('div', {
      class: 'scrim',
      onclick: () => root.classList.remove('nav-open'),
    }),
  )
  if (listPane) root.append(listPane)
  if (readPane) root.append(readPane)
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-menu]')) root.classList.toggle('nav-open')
  })
  app.replaceChildren(root)
  return root
}

export function scopeLabel() {
  if (state.box) {
    return state.inboxes.find((inbox) => inbox.id === state.box)?.address ?? ''
  }
  if (state.domain) {
    return (
      state.domains.find((domain) => domain.id === state.domain)?.domain ?? ''
    )
  }
  return state.domains.length > 1 ? '全部域名' : ''
}

export function setScope(box, domain) {
  state.box = box
  state.domain = domain
  writePref('scope', `${box}|${domain}`)
  const name = parseRoute().name
  if (['inbox', 'sent', 'archived', 'spam', 'search'].includes(name)) route()
  else location.hash = '#/inbox'
}

export function menuButton() {
  return h(
    'button',
    {
      class: 'icon-btn menu-btn',
      type: 'button',
      'data-menu': '1',
      'aria-label': '菜单',
    },
    icon('menu'),
  )
}

export function backButton(href) {
  return h(
    'a',
    {
      class: 'icon-btn',
      href,
      'aria-label': '返回列表',
      title: '返回（u）',
      'data-key': 'u',
    },
    icon('back'),
  )
}

export function placeholder(text) {
  return h(
    'div',
    { class: 'read-pane' },
    h(
      'div',
      { class: 'empty', style: 'padding-top:18vh' },
      icon('inbox'),
      h('strong', {}, text),
      h('span', {}, '按 ? 查看键盘快捷键'),
    ),
  )
}
