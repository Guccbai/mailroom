// Mailroom web app entry: routing and start-up. Plain browser modules, no build step.

import { composePane, draftPane, draftsListPane } from './drafts.js'
import './keys.js'
import { placeholder, renderLogin, renderNoPassword, shell } from './layout.js'
import {
  ApiError,
  api,
  app,
  applyTheme,
  h,
  lazyPane,
  mark,
  parseRoute,
  readPref,
  request,
  state,
} from './lib.js'
import { messageListPane, refreshCounts } from './mail.js'
import { settingsPane } from './settings.js'
import { threadPane } from './thread.js'

applyTheme()

/* ---------- app ---------- */

export async function loadInboxes() {
  const [inboxes, domains] = await Promise.all([
    api('inboxes.list', { limit: 100 }),
    api('domains.list', { limit: 100 }),
  ])
  state.inboxes = inboxes.items
    .filter((inbox) => inbox.enabled !== false)
    .sort((a, b) => a.address.localeCompare(b.address))
  state.domains = domains.items.sort((a, b) => a.domain.localeCompare(b.domain))
  if (state.box && !state.inboxes.some((inbox) => inbox.id === state.box))
    state.box = ''
  if (
    state.domain &&
    !state.domains.some((domain) => domain.id === state.domain)
  )
    state.domain = ''
}

export const TITLES = {
  inbox: '收件箱',
  sent: '已发送',
  archived: '已归档',
  spam: '垃圾邮件',
  search: '搜索结果',
}

export async function route() {
  const current = parseRoute()
  const name = current.name
  if (name === 'message' && current.id) {
    const message = await api('messages.get', {
      id: current.id,
      includeBody: false,
    })
    location.replace(
      `#/thread/${encodeURIComponent(message.threadId)}?from=inbox`,
    )
    return
  }
  if (name === 'compose') {
    shell('compose', null, lazyPane('read-pane', composePane), { wide: true })
    return
  }
  if (name === 'settings') {
    shell(
      'settings',
      null,
      lazyPane('read-pane', () => settingsPane(current.id ?? 'overview')),
      { wide: true },
    )
    return
  }
  if (name === 'drafts' || name === 'draft') {
    shell(
      'drafts',
      lazyPane('list-pane', () => draftsListPane(current.id)),
      current.id
        ? lazyPane('read-pane', () => draftPane(current.id))
        : placeholder('选择一份草稿查看'),
      { reading: Boolean(current.id) },
    )
    return
  }
  if (name === 'thread' && current.id) {
    const from = current.params.get('from') || 'inbox'
    const listName = TITLES[from] ? from : 'inbox'
    shell(
      listName,
      messageListPane(listName, TITLES[listName], current.id),
      threadPane(current.id),
      { reading: true },
    )
    return
  }
  const listName = TITLES[name] ? name : 'inbox'
  shell(
    listName,
    messageListPane(listName, TITLES[listName]),
    placeholder('选择一封邮件阅读'),
  )
}

export async function start() {
  const session = await request('/v1/session')
  if (!session.passwordConfigured) {
    renderNoPassword()
    return
  }
  if (!session.authenticated) {
    renderLogin()
    return
  }
  const [box = '', domain = ''] = readPref('scope', '|').split('|')
  state.box = box
  state.domain = domain
  state.collapsed = new Set(
    readPref('collapsed', '').split(',').filter(Boolean),
  )
  await loadInboxes()
  await route()
  refreshCounts()
}

start().catch((error) => {
  if (error instanceof ApiError && error.status === 401) return
  app.replaceChildren(
    h(
      'div',
      { class: 'login' },
      h(
        'div',
        { class: 'login-card' },
        mark(),
        h('h1', {}, '加载失败'),
        h('p', { class: 'error' }, error.message),
        h(
          'button',
          { class: 'btn primary', onclick: () => location.reload() },
          '重新加载',
        ),
      ),
    ),
  )
})
