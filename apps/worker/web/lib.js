import { route } from './app.js'
import { renderLogin } from './layout.js'

// Mailroom web app. Plain browser JavaScript with no build step.
// Every value from the API is inserted as text, never as HTML, except email
// HTML bodies, which render inside a sandboxed frame with scripts disabled.

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const app = document.getElementById('app')
export const toastEl = document.getElementById('toast')

export const state = {
  inboxes: [],
  domains: [],
  box: '',
  domain: '',
  filter: 'all',
  counts: {},
  draftTab: 'pending',
  collapsed: new Set(),
}

/* ---------- preferences ---------- */

export function readPref(key, fallback) {
  try {
    return localStorage.getItem(`mailroom:${key}`) ?? fallback
  } catch {
    return fallback
  }
}

export function writePref(key, value) {
  try {
    localStorage.setItem(`mailroom:${key}`, value)
  } catch {
    // Preferences are a convenience; ignore storage errors.
  }
}

export const THEMES = [
  ['auto', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色'],
]

export function applyTheme(theme = readPref('theme', 'auto')) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme
  } else {
    delete document.documentElement.dataset.theme
  }
}

export function setTheme(theme) {
  writePref('theme', theme)
  applyTheme(theme)
}

/* ---------- helpers ---------- */

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'dataset') Object.assign(el.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value)
    } else if (value === true) el.setAttribute(key, '')
    else el.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    el.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    )
  }
  return el
}

const SVG_NS = 'http://www.w3.org/2000/svg'

const ICONS = {
  inbox: 'M3 13h5l1.5 3h5l1.5-3h5M5 5h14l2 8v6H3v-6z',
  send: 'M21 3 10 14M21 3l-7 18-4-7-7-4z',
  draft: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  spam: 'M12 3 2 20h20zM12 10v4M12 17v.5',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  reply: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v5',
  forward: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0-6 6v5',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  menu: 'M4 6h16M4 12h16M4 18h16',
  back: 'M19 12H5M12 19l-7-7 7-7',
  clip: 'M21 11.5 12.5 20a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  auto: 'M12 3a9 9 0 1 0 0 18zM12 3a9 9 0 0 1 0 18',
  refresh:
    'M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5',
  keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  chevron: 'M6 9l6 6 6-6',
  globe:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6 9 17l-5-5',
  unread: 'M3 7l9 6 9-6M3 6h18v12H3z',
  alert:
    'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  logout: 'M9 21H4V3h5M16 17l5-5-5-5M21 12H9',
  link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
}

export function icon(name, label) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'icon')
  if (label) {
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', label)
  } else {
    svg.setAttribute('aria-hidden', 'true')
  }
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', ICONS[name] ?? ICONS.alert)
  svg.append(path)
  return svg
}

export function mark() {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('aria-hidden', 'true')
  const ring = document.createElementNS(SVG_NS, 'circle')
  for (const [key, value] of Object.entries({
    cx: 16,
    cy: 16,
    r: 13.2,
    fill: 'none',
    stroke: '#b4925f',
    'stroke-width': 1.4,
  }))
    ring.setAttribute(key, String(value))
  const dot = document.createElementNS(SVG_NS, 'circle')
  for (const [key, value] of Object.entries({
    cx: 16,
    cy: 16,
    r: 4.6,
    fill: '#b4925f',
  }))
    dot.setAttribute(key, String(value))
  svg.append(ring, dot)
  return svg
}

export function skeletonRows(count = 6) {
  return Array.from({ length: count }, () =>
    h(
      'div',
      { class: 'skeleton', 'aria-hidden': 'true' },
      h('i'),
      h('i'),
      h('i'),
    ),
  )
}

export function emptyState(iconName, title, hintText) {
  return h(
    'div',
    { class: 'empty' },
    icon(iconName),
    h('strong', {}, title),
    hintText ? h('span', {}, hintText) : null,
  )
}

export function errorState(error, retry) {
  return h(
    'div',
    { class: 'empty error', role: 'alert' },
    icon('alert'),
    h('strong', {}, '加载失败'),
    h('span', {}, error?.message ?? String(error)),
    retry
      ? h(
          'button',
          { class: 'btn small', onclick: retry },
          icon('refresh'),
          '重试',
        )
      : null,
  )
}

/** A pane that shows a placeholder at once and fills in when data arrives. */
export function lazyPane(className, load) {
  const pane = h(
    'section',
    { class: className, 'aria-busy': 'true' },
    className === 'read-pane'
      ? h('div', { class: 'read-inner' }, skeletonRows(4))
      : skeletonRows(),
  )
  const fill = () =>
    load()
      .then((content) => {
        pane.replaceWith(content)
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 401) return
        pane.removeAttribute('aria-busy')
        pane.replaceChildren(
          className === 'read-pane'
            ? h('div', { class: 'read-inner' }, errorState(error, retry))
            : errorState(error, retry),
        )
      })
  const retry = () => {
    pane.setAttribute('aria-busy', 'true')
    pane.replaceChildren(...skeletonRows())
    fill()
  }
  fill()
  return pane
}

export function toast(message, tone) {
  toastEl.textContent = message
  toastEl.className = tone === 'bad' ? 'bad' : ''
  toastEl.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => {
    toastEl.hidden = true
  }, 3200)
}

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

export async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.ok) {
    const error = payload?.error ?? {}
    if (response.status === 401 && path !== '/v1/session') {
      renderLogin()
    }
    throw new ApiError(
      error.code ?? 'REMOTE_ERROR',
      error.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
    )
  }
  return payload.data
}

export function api(id, params = {}) {
  return request(`/v1/operations/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ params }),
  })
}

export const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
export const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
})
export const fullFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function shortDate(value) {
  if (!value) return ''
  const date = new Date(value)
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? timeFormat.format(date)
    : dateFormat.format(date)
}

export function fullDate(value) {
  return value ? fullFormat.format(new Date(value)) : ''
}

export function bytes(size) {
  const value = Number(size) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function splitAddresses(value) {
  return value
    .split(/[\s,;，；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export function downloadUrl(id, inline = false) {
  return `/v1/attachments/${encodeURIComponent(id)}/download${inline ? '?inline=1' : ''}`
}

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        contentBase64: result.slice(result.indexOf(',') + 1),
        size: file.size,
      })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value)
    toast('已复制')
  } catch {
    toast('复制失败，请手动选择复制', 'bad')
  }
}

export function copyBlock(text) {
  return h(
    'div',
    { class: 'copy-row' },
    h('pre', { class: 'code' }, text),
    h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        'aria-label': '复制',
        onclick: () => copyText(text),
      },
      icon('copy'),
    ),
  )
}

export function confirmDialog(title, lines, confirmLabel = '确定') {
  return new Promise((resolve) => {
    const dialog = h(
      'dialog',
      {},
      h('h3', {}, title),
      ...lines.map((line) => h('p', { class: 'hint' }, line)),
      h(
        'div',
        { class: 'actions' },
        h('span', { class: 'spacer' }),
        h(
          'button',
          {
            class: 'btn',
            value: 'cancel',
            onclick: () => dialog.close('cancel'),
          },
          '取消',
        ),
        h(
          'button',
          {
            class: 'btn primary',
            value: 'ok',
            onclick: () => dialog.close('ok'),
          },
          confirmLabel,
        ),
      ),
    )
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok')
      dialog.remove()
    })
    document.body.append(dialog)
    dialog.showModal()
  })
}

export function promptDialog(title, label) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', required: true, maxlength: 2000 })
    const dialog = h(
      'dialog',
      {},
      h('h3', {}, title),
      h('div', { class: 'field' }, h('label', {}, label), input),
      h(
        'div',
        { class: 'actions', style: 'margin-top:14px' },
        h('span', { class: 'spacer' }),
        h(
          'button',
          { class: 'btn', onclick: () => dialog.close('cancel') },
          '取消',
        ),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              if (input.value.trim()) dialog.close('ok')
            },
          },
          '确定',
        ),
      ),
    )
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok' ? input.value.trim() : null)
      dialog.remove()
    })
    document.body.append(dialog)
    dialog.showModal()
    input.focus()
  })
}

export async function withBusy(button, task) {
  button.disabled = true
  try {
    return await task()
  } catch (error) {
    toast(error.message, 'bad')
    return undefined
  } finally {
    button.disabled = false
  }
}

/* ---------- routing ---------- */

export function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '')
  const [path, query = ''] = hash.split('?')
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  return {
    name: parts[0] || 'inbox',
    id: parts[1],
    params: new URLSearchParams(query),
  }
}

export function go(path) {
  location.hash = `#/${path}`
}

window.addEventListener('hashchange', () => {
  route().catch((error) => toast(error.message, 'bad'))
})
