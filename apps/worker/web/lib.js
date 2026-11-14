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
  box: '',
  counts: {},
  draftTab: 'pending',
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

export function toast(message) {
  toastEl.textContent = message
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
  const label = button.textContent
  button.disabled = true
  try {
    return await task()
  } catch (error) {
    toast(error.message)
    return undefined
  } finally {
    button.disabled = false
    button.textContent = label
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
  route().catch((error) => toast(error.message))
})
