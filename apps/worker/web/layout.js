// Part of the Mailroom web app. See app.js.

import { route, start } from './app.js'
import { app, h, parseRoute, request, state, withBusy } from './lib.js'

/* ---------- login ---------- */

export function renderLogin(message) {
  const error = h('p', { class: 'error' }, message ?? '')
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
      h('label', { for: 'password' }, '密码'),
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
        h('img', { src: '/favicon.svg', width: 36, height: 36, alt: '' }),
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
  ['inbox', '收件箱'],
  ['sent', '已发送'],
  ['drafts', '草稿与审批'],
  ['archived', '已归档'],
  ['spam', '垃圾邮件'],
]

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
    h(
      'div',
      { class: 'brand' },
      h('img', { src: '/favicon.svg', alt: '' }),
      'Mailroom',
    ),
    h('a', { class: 'btn primary compose-btn', href: '#/compose' }, '写邮件'),
    FOLDERS.map(([key, label]) =>
      h(
        'a',
        {
          class: `nav-item${active === key ? ' active' : ''}`,
          href: `#/${key}`,
          onclick: () => root.classList.remove('nav-open'),
        },
        h('span', {}, label),
        state.counts[key]
          ? h('span', { class: 'nav-count' }, state.counts[key])
          : null,
      ),
    ),
    h('div', { class: 'nav-sep' }),
    h('div', { class: 'hint', style: 'padding:0 10px 4px' }, '邮箱地址'),
    h(
      'a',
      {
        class: `nav-item${state.box ? '' : ' active'}`,
        href: '#/inbox',
        onclick: () => setBox(''),
      },
      '全部',
    ),
    state.inboxes.map((inbox) =>
      h(
        'a',
        {
          class: `nav-item${state.box === inbox.id ? ' active' : ''}`,
          href: '#/inbox',
          title: inbox.address,
          onclick: () => setBox(inbox.id),
        },
        h('span', { class: 'row-from' }, inbox.address),
      ),
    ),
    h('div', { class: 'nav-sep' }),
    h(
      'a',
      {
        class: `nav-item${active === 'settings' ? ' active' : ''}`,
        href: '#/settings',
      },
      '设置',
    ),
  )
  root.append(nav)
  if (listPane) root.append(listPane)
  if (readPane) root.append(readPane)
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-menu]')) root.classList.toggle('nav-open')
  })
  app.replaceChildren(root)
  return root
}

export function setBox(id) {
  state.box = id
  if (parseRoute().name === 'inbox') route()
}

export function menuButton() {
  return h(
    'button',
    { class: 'icon-btn', 'data-menu': '1', 'aria-label': '菜单' },
    '☰',
  )
}

export function backButton(href) {
  return h('a', { class: 'icon-btn', href, 'aria-label': '返回' }, '←')
}

export function placeholder(text) {
  return h('div', { class: 'read-pane' }, h('div', { class: 'empty' }, text))
}
