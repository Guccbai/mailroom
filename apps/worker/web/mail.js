// Part of the Mailroom web app. See app.js. Message lists and search.

import { menuButton, scopeLabel } from './layout.js'
import {
  api,
  emptyState,
  errorState,
  go,
  h,
  icon,
  parseRoute,
  shortDate,
  skeletonRows,
  state,
  toast,
  withBusy,
} from './lib.js'

/* ---------- message lists ---------- */

export function listParams(name) {
  const base = state.box
    ? { inboxId: state.box }
    : state.domain
      ? { domainId: state.domain }
      : {}
  if (name === 'inbox') {
    return {
      ...base,
      direction: 'inbound',
      statuses: state.filter === 'unread' ? ['unread'] : ['unread', 'read'],
    }
  }
  if (name === 'sent') return { ...base, direction: 'outbound' }
  if (name === 'archived') return { ...base, status: 'archived' }
  if (name === 'spam') return { ...base, status: 'spam' }
  return base
}

function displayName(address) {
  const value = String(address ?? '')
  const match = value.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/)
  return match ? match[1] : value
}

function initial(address) {
  const name = displayName(address).trim()
  return name ? Array.from(name)[0] : '?'
}

function inboxAddress(id) {
  return state.inboxes.find((inbox) => inbox.id === id)?.address
}

export function messageRow(item, activeThread, from) {
  const outbound = item.direction === 'outbound'
  const who = outbound
    ? `发给 ${(item.to ?? []).map(displayName).join(', ')}`
    : displayName(item.from)
  const mailbox =
    !state.box && state.inboxes.length > 1 && item.inboxId
      ? inboxAddress(item.inboxId)
      : null
  return h(
    'a',
    {
      class: `row${item.status === 'unread' ? ' unread' : ''}${item.threadId === activeThread ? ' active' : ''}`,
      href: `#/thread/${encodeURIComponent(item.threadId)}?from=${from}`,
      dataset: { id: item.id ?? '', status: item.status ?? '' },
    },
    h(
      'span',
      { class: `avatar${outbound ? ' alt' : ''}`, 'aria-hidden': 'true' },
      initial(outbound ? item.to?.[0] : item.from),
    ),
    h(
      'div',
      { class: 'row-top' },
      h('span', { class: 'row-from', title: outbound ? '' : item.from }, who),
      h('span', {}, shortDate(item.receivedAt)),
    ),
    h(
      'div',
      { class: 'row-subject' },
      h('span', {}, item.subject || '（无主题）'),
      item.hasAttachments || item.attachmentCount
        ? h('span', { class: 'clip' }, icon('clip', '有附件'))
        : null,
      mailbox ? h('span', { class: 'tag' }, mailbox.split('@')[0]) : null,
    ),
    h('div', { class: 'row-preview' }, item.preview || item.snippet || ''),
  )
}

function filterBar(name, onChange) {
  if (name !== 'inbox') return null
  const options = [
    ['all', '全部'],
    ['unread', '未读'],
    ['attachments', '有附件'],
  ]
  return h(
    'div',
    { class: 'filters', role: 'group', 'aria-label': '筛选' },
    options.map(([key, label]) =>
      h(
        'button',
        {
          class: `filter${state.filter === key ? ' active' : ''}`,
          type: 'button',
          'aria-pressed': state.filter === key ? 'true' : 'false',
          onclick: () => {
            state.filter = key
            onChange()
          },
        },
        label,
      ),
    ),
    h(
      'button',
      {
        class: 'filter link',
        type: 'button',
        title: '把已加载的未读邮件标为已读',
        onclick: async (event) => {
          const rows = [
            ...document.querySelectorAll('.list .row[data-status="unread"]'),
          ]
          if (!rows.length) {
            toast('没有未读邮件')
            return
          }
          await withBusy(event.currentTarget, async () => {
            await Promise.all(
              rows.map((row) =>
                api('messages.update', { id: row.dataset.id, status: 'read' }),
              ),
            )
            toast(`已标记 ${rows.length} 封为已读`)
            await refreshCounts()
            onChange()
          })
        },
      },
      '全部标为已读',
    ),
  )
}

function searchBox(name) {
  const search = h('input', {
    class: 'search',
    type: 'search',
    placeholder: '搜索邮件',
    'aria-label': '搜索邮件',
    enterkeyhint: 'search',
    value: name === 'search' ? (parseRoute().params.get('q') ?? '') : '',
    onkeydown: (event) => {
      if (event.key !== 'Enter') return
      const query = search.value.trim()
      if (query.length < 2) {
        toast('至少输入 2 个字')
        return
      }
      go(`search?q=${encodeURIComponent(query)}`)
    },
  })
  return h(
    'div',
    { class: 'searchbox' },
    icon('search'),
    search,
    h('span', { class: 'kbd-hint' }, h('kbd', {}, '/')),
  )
}

const EMPTY = {
  inbox: ['inbox', '收件箱是空的', '新邮件到达后会出现在这里'],
  sent: ['send', '还没有发出的邮件', '按 c 写一封新邮件'],
  archived: ['archive', '没有归档的邮件', '在邮件中按 e 即可归档'],
  spam: ['spam', '没有垃圾邮件', ''],
}

export function messageListPane(name, title, activeThread) {
  const list = h('div', { class: 'list', 'aria-busy': 'true' })
  const from = name
  const scope = scopeLabel()
  const filters = h('div')
  const pane = h(
    'section',
    { class: 'list-pane', 'aria-label': title },
    h(
      'div',
      { class: 'pane-head' },
      menuButton(),
      searchBox(name),
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: '刷新',
          'aria-label': '刷新',
          onclick: () => reload(),
        },
        icon('refresh'),
      ),
    ),
    h(
      'div',
      { class: 'pane-title' },
      h('h2', {}, title),
      scope ? h('span', { class: 'scope' }, scope) : null,
    ),
    filters,
    list,
  )
  let cursor
  let shown = 0
  const append = (items) => {
    const visibleItems =
      name === 'inbox' && state.filter === 'attachments'
        ? items.filter((item) => item.hasAttachments || item.attachmentCount)
        : items
    shown += visibleItems.length
    for (const item of visibleItems)
      list.append(messageRow(item, activeThread, from))
  }
  const loadSearch = async () => {
    const query = parseRoute().params.get('q') ?? ''
    const result = await api('messages.search', {
      query,
      limit: 30,
      ...(state.box ? { inboxId: state.box } : {}),
    })
    list.replaceChildren()
    append(
      result.items.map((item) => ({
        id: item.messageId ?? item.id,
        threadId: item.threadId ?? item.metadata?.threadId,
        inboxId: item.inboxId ?? item.metadata?.inboxId,
        subject: item.subject ?? '',
        from: item.from ?? '',
        receivedAt: item.receivedAt ?? item.metadata?.received_at,
        snippet: item.snippet,
        status: 'read',
      })),
    )
    if (!shown) {
      list.append(
        emptyState('search', '没有找到相关邮件', `换个关键词试试：“${query}”`),
      )
    }
  }
  const loadPage = async () => {
    const result = await api('messages.list', {
      ...listParams(name),
      limit: 40,
      ...(cursor ? { cursor } : {}),
    })
    if (!cursor) list.replaceChildren()
    list.querySelector('.more')?.remove()
    append(result.items)
    cursor = result.nextCursor
    if (cursor) {
      const more = h(
        'button',
        { class: 'btn more', type: 'button' },
        '加载更多',
      )
      more.addEventListener('click', () => withBusy(more, loadPage))
      list.append(more)
    } else if (!shown) {
      const [iconName, heading, hintText] =
        name === 'inbox' && state.filter !== 'all'
          ? ['check', '没有符合筛选的邮件', '']
          : (EMPTY[name] ?? EMPTY.inbox)
      list.append(emptyState(iconName, heading, hintText))
    }
  }
  const reload = () => {
    cursor = undefined
    shown = 0
    filters.replaceChildren(filterBar(name, reload) ?? '')
    list.setAttribute('aria-busy', 'true')
    list.replaceChildren(...skeletonRows())
    const task = name === 'search' ? loadSearch() : loadPage()
    task
      .catch((error) => {
        list.replaceChildren(errorState(error, reload))
      })
      .finally(() => list.removeAttribute('aria-busy'))
  }
  reload()
  return pane
}

export async function refreshCounts() {
  try {
    const scope = state.box
      ? { inboxId: state.box }
      : state.domain
        ? { domainId: state.domain }
        : {}
    const [unread, drafts] = await Promise.all([
      api('messages.list', {
        ...scope,
        direction: 'inbound',
        status: 'unread',
        limit: 100,
      }),
      api('drafts.list', { status: 'pending', limit: 100 }),
    ])
    state.counts.inbox =
      unread.items.length >= 100 ? '99+' : unread.items.length || ''
    state.counts.drafts = drafts.items.length || ''
    for (const element of document.querySelectorAll('.sidebar .nav-item')) {
      const key = element.getAttribute('href')?.slice(2)
      if (!key || !(key in state.counts)) continue
      element.querySelector('.nav-count')?.remove()
      if (state.counts[key]) {
        element.append(h('span', { class: 'nav-count' }, state.counts[key]))
      }
    }
    document.title = state.counts.inbox
      ? `(${state.counts.inbox}) Mailroom`
      : 'Mailroom'
  } catch {
    // Counts are decorative; ignore failures.
  }
}
