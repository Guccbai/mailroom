// Keyboard shortcuts for the Mailroom web app. Buttons opt in with a
// data-key attribute; list navigation works on the rows of the open list.

import { go, h } from './lib.js'

export const SHORTCUTS = [
  [['c'], '写邮件'],
  [['/'], '搜索'],
  [['j'], '下一封'],
  [['k'], '上一封'],
  [['Enter'], '打开选中的邮件'],
  [['u'], '返回列表'],
  [['r'], '回复'],
  [['f'], '转发'],
  [['e'], '归档'],
  [['#'], '标为垃圾邮件'],
  [['Shift', 'U'], '标为未读'],
  [['g', 'i'], '去收件箱'],
  [['g', 's'], '去已发送'],
  [['g', 'd'], '去草稿与审批'],
  [['g', 'a'], '去已归档'],
  [['g', ','], '去设置'],
  [['?'], '显示快捷键'],
]

const GO_TARGETS = {
  i: 'inbox',
  s: 'sent',
  d: 'drafts',
  a: 'archived',
  t: 'settings',
  ',': 'settings',
}

export function showShortcuts() {
  if (document.querySelector('dialog.shortcuts')) return
  const dialog = h(
    'dialog',
    { class: 'shortcuts' },
    h('h3', {}, '键盘快捷键'),
    h(
      'dl',
      { class: 'shortcut-list' },
      SHORTCUTS.map(([keys, label]) => [
        h(
          'dt',
          {},
          keys.map((key) => h('kbd', {}, key)),
        ),
        h('dd', {}, label),
      ]),
    ),
    h(
      'div',
      { class: 'actions' },
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => dialog.close() }, '关闭'),
    ),
  )
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
}

function typing(target) {
  return Boolean(
    target.closest?.('input, textarea, select, [contenteditable="true"]'),
  )
}

function visible(element) {
  return element && element.offsetParent !== null && !element.disabled
}

function pressKey(key) {
  const target = [...document.querySelectorAll(`[data-key="${key}"]`)].find(
    visible,
  )
  if (!target) return false
  target.click()
  return true
}

function moveFocus(step) {
  const rows = [...document.querySelectorAll('.list .row')].filter(visible)
  if (!rows.length) return
  const current = rows.findIndex((row) => row.classList.contains('focused'))
  const active = rows.findIndex((row) => row.classList.contains('active'))
  const from = current >= 0 ? current : active
  const next = Math.min(rows.length - 1, Math.max(0, from + step))
  for (const row of rows) row.classList.remove('focused')
  const row = rows[from < 0 ? 0 : next]
  row.classList.add('focused')
  row.scrollIntoView({ block: 'nearest' })
  // When a thread is open, j and k open the neighbouring thread directly.
  if (active >= 0) row.click()
}

let pendingGo = 0

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey)
    return
  if (document.querySelector('dialog[open]')) return
  if (typing(event.target)) {
    if (event.key === 'Escape') event.target.blur()
    return
  }
  const key = event.key
  if (pendingGo && Date.now() - pendingGo < 1200) {
    pendingGo = 0
    const target = GO_TARGETS[key]
    if (target) {
      event.preventDefault()
      go(target)
    }
    return
  }
  pendingGo = 0
  if (key === 'g') {
    pendingGo = Date.now()
    return
  }
  if (key === '?') {
    event.preventDefault()
    showShortcuts()
    return
  }
  if (key === '/') {
    const search = document.querySelector('.search')
    if (visible(search)) {
      event.preventDefault()
      search.focus()
      search.select()
    }
    return
  }
  if (key === 'c') {
    event.preventDefault()
    go('compose')
    return
  }
  if (key === 'j') {
    event.preventDefault()
    moveFocus(1)
    return
  }
  if (key === 'k') {
    event.preventDefault()
    moveFocus(-1)
    return
  }
  if (key === 'Enter' || key === 'o') {
    const row = document.querySelector('.list .row.focused')
    if (row) {
      event.preventDefault()
      row.click()
    }
    return
  }
  if (key === 'Escape') {
    if (pressKey('u')) event.preventDefault()
    return
  }
  if (['u', 'r', 'f', 'e', '#', 'U'].includes(key) && pressKey(key)) {
    event.preventDefault()
  }
})
