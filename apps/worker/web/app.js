// Mailroom web app entry: routing and start-up. Plain browser modules, no build step.

import { composePane, draftPane, draftsListPane } from './drafts.js'
import { placeholder, renderLogin, renderNoPassword, shell } from './layout.js'
import { ApiError, api, app, h, parseRoute, request, state } from './lib.js'
import { messageListPane, refreshCounts, threadPane } from './mail.js'
import { settingsPane } from './settings.js'

/* ---------- app ---------- */

export async function loadInboxes() {
  const result = await api('inboxes.list', { limit: 100 })
  state.inboxes = result.items.filter((inbox) => inbox.enabled !== false)
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
    shell('compose', null, await composePane(), { wide: true })
    return
  }
  if (name === 'settings') {
    shell('settings', null, await settingsPane(), { wide: true })
    return
  }
  if (name === 'drafts' || name === 'draft') {
    const [list, read] = await Promise.all([
      draftsListPane(current.id),
      current.id
        ? draftPane(current.id)
        : Promise.resolve(placeholder('选择一份草稿查看')),
    ])
    shell('drafts', list, read, { reading: Boolean(current.id) })
    return
  }
  if (name === 'thread' && current.id) {
    const from = current.params.get('from') || 'inbox'
    const listName = TITLES[from] ? from : 'inbox'
    const [list, read] = await Promise.all([
      messageListPane(listName, TITLES[listName], current.id),
      threadPane(current.id),
    ])
    shell(listName, list, read, { reading: true })
    return
  }
  const listName = TITLES[name] ? name : 'inbox'
  shell(
    listName,
    await messageListPane(listName, TITLES[listName]),
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
  await Promise.all([loadInboxes(), refreshCounts()])
  await route()
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
        h('h1', {}, '加载失败'),
        h('p', { class: 'error' }, error.message),
      ),
    ),
  )
})
