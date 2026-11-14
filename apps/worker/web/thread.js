// Part of the Mailroom web app. See app.js. Reading a thread, replying and
// forwarding, plus the compose helpers shared with drafts.js.

import { route } from './app.js'
import { backButton } from './layout.js'
import {
  api,
  bytes,
  confirmDialog,
  downloadUrl,
  fullDate,
  go,
  h,
  icon,
  lazyPane,
  MAX_ATTACHMENT_BYTES,
  parseRoute,
  readFile,
  splitAddresses,
  toast,
  validEmail,
  withBusy,
} from './lib.js'
import { refreshCounts } from './mail.js'

/* ---------- reading ---------- */

export function mailFrame(html, allowImages) {
  const policy = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: cid:${allowImages ? ' https: http:' : ''}`
  const frame = h('iframe', {
    class: 'mail-frame',
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    referrerpolicy: 'no-referrer',
    title: '邮件内容',
  })
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base target="_blank"><style>html{color-scheme:light}body{margin:0;padding:6px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#14202f;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%}a{color:#8a6a3c}</style></head><body>${html}</body></html>`
  const resize = () => {
    try {
      const doc = frame.contentDocument
      if (doc?.documentElement) {
        frame.style.height = `${Math.min(doc.documentElement.scrollHeight + 8, 20000)}px`
      }
    } catch {
      // Ignore sizing errors.
    }
  }
  frame.addEventListener('load', () => {
    resize()
    setTimeout(resize, 400)
  })
  return frame
}

export function messageBody(message) {
  const holder = h('div', { class: 'msg-body' })
  const hasHtml = Boolean(message.html)
  let mode = hasHtml ? 'html' : 'text'
  let allowImages = false
  const tab = (key, label) =>
    h(
      'button',
      {
        class: `tab${mode === key ? ' active' : ''}`,
        type: 'button',
        onclick: () => {
          mode = key
          draw()
        },
      },
      label,
    )
  const draw = () => {
    const controls = h('div', { class: 'body-switch' })
    if (hasHtml && message.text)
      controls.append(tab('html', '原样式'), tab('text', '纯文本'))
    if (mode === 'html' && !allowImages) {
      controls.append(
        h(
          'button',
          {
            class: 'tab',
            type: 'button',
            title: '远程图片可能用于追踪是否已读',
            onclick: () => {
              allowImages = true
              draw()
            },
          },
          '显示远程图片',
        ),
      )
    }
    holder.replaceChildren(
      controls.childNodes.length ? controls : '',
      mode === 'html'
        ? mailFrame(message.html, allowImages)
        : h('pre', { class: 'msg-text' }, message.text || '（没有正文）'),
    )
  }
  draw()
  return holder
}

export function attachmentChips(attachments) {
  if (!attachments?.length) return null
  return h(
    'div',
    { class: 'attachments' },
    attachments.map((attachment) =>
      h(
        'a',
        {
          class: 'chip',
          href: downloadUrl(attachment.id),
          download: attachment.filename || '',
        },
        icon('clip'),
        h('span', {}, attachment.filename || '未命名文件'),
        h('small', {}, bytes(attachment.sizeBytes)),
      ),
    ),
  )
}

function messageCard(message, { collapsed, onForward }) {
  const outbound = message.direction === 'outbound'
  const card = h('article', {
    class: `msg${outbound ? ' outbound' : ''}${collapsed ? ' collapsed collapsible' : ' collapsible'}`,
  })
  const head = h(
    'div',
    {
      class: 'msg-head',
      onclick: (event) => {
        if (event.target.closest('button, a')) return
        card.classList.toggle('collapsed')
      },
    },
    h(
      'span',
      { class: `avatar${outbound ? ' alt' : ''}`, 'aria-hidden': 'true' },
      Array.from(String(message.from ?? '?').trim())[0] ?? '?',
    ),
    h(
      'div',
      { class: 'msg-meta' },
      h('div', {}, h('strong', {}, message.from)),
      h('div', { class: 'msg-preview' }, message.preview ?? ''),
      h(
        'div',
        { class: 'msg-detail' },
        `收件人：${(message.to ?? []).join(', ')}`,
        message.cc?.length
          ? h('div', {}, `抄送：${message.cc.join(', ')}`)
          : null,
      ),
    ),
    h('div', { class: 'msg-date' }, fullDate(message.receivedAt)),
    h(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        title: '转发这封',
        'aria-label': '转发这封',
        onclick: () => onForward(message),
      },
      icon('forward'),
    ),
  )
  card.append(
    head,
    messageBody(message),
    attachmentChips(message.attachments) ?? '',
  )
  return card
}

/* ---------- composing ---------- */

export function attachmentPicker(files) {
  const chips = h('div', { class: 'actions' })
  const input = h('input', { type: 'file', multiple: true, hidden: true })
  const total = () => files.reduce((sum, item) => sum + item.size, 0)
  const draw = () => {
    chips.replaceChildren(
      ...files.map((file, index) =>
        h(
          'span',
          { class: 'chip' },
          icon('clip'),
          h('span', {}, file.filename),
          h('small', {}, bytes(file.size)),
          h(
            'button',
            {
              type: 'button',
              'aria-label': `移除 ${file.filename}`,
              onclick: () => {
                files.splice(index, 1)
                draw()
              },
            },
            '×',
          ),
        ),
      ),
    )
  }
  input.addEventListener('change', async () => {
    for (const file of input.files) {
      if (files.length >= 10) {
        toast('最多 10 个附件', 'bad')
        break
      }
      if (total() + file.size > MAX_ATTACHMENT_BYTES) {
        toast('附件合计不能超过 10 MB', 'bad')
        break
      }
      files.push(await readFile(file))
    }
    input.value = ''
    draw()
  })
  return h(
    'div',
    { class: 'field' },
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        { type: 'button', class: 'btn small', onclick: () => input.click() },
        icon('clip'),
        '添加附件',
      ),
      h('span', { class: 'hint' }, '最多 10 个，合计 10 MB'),
    ),
    input,
    chips,
  )
}

export function payloadAttachments(files) {
  return files.map(({ filename, contentType, contentBase64 }) => ({
    filename,
    contentType,
    contentBase64,
  }))
}

export function addressList(value, label, { required = false } = {}) {
  const list = splitAddresses(value)
  if (required && !list.length) throw new Error(`请填写${label}`)
  const bad = list.find((item) => !validEmail(item))
  if (bad) throw new Error(`${label}地址不正确：${bad}`)
  return list
}

export async function approveAndSend(draftId, recipients, extra = []) {
  const ok = await confirmDialog(
    '确认发送？',
    [`发给：${recipients.join(', ')}`, ...extra, '发出后无法撤回。'],
    '发送',
  )
  if (!ok) return false
  await api('drafts.approve', { id: draftId, approvedBy: 'owner (web)' })
  await api('drafts.send', {
    id: draftId,
    idempotencyKey: `web-${crypto.randomUUID()}`,
  })
  return true
}

function sendControls(create, recipientsOf, onSent, extraOf = () => []) {
  const sendBtn = h(
    'button',
    { class: 'btn primary', type: 'button', title: '发送（Ctrl+Enter）' },
    icon('send'),
    '发送',
  )
  const saveBtn = h('button', { class: 'btn', type: 'button' }, '存为草稿')
  saveBtn.addEventListener('click', () =>
    withBusy(saveBtn, async () => {
      const draft = await create()
      toast('草稿已保存，可在“草稿与审批”中发送')
      go(`draft/${encodeURIComponent(draft.id)}`)
    }),
  )
  sendBtn.addEventListener('click', () =>
    withBusy(sendBtn, async () => {
      const draft = await create()
      const sent = await approveAndSend(
        draft.id,
        recipientsOf(draft),
        extraOf(draft),
      )
      if (sent) {
        toast('已发送')
        onSent()
      } else {
        toast('已存为草稿，未发送')
        go(`draft/${encodeURIComponent(draft.id)}`)
      }
    }),
  )
  return { sendBtn, saveBtn }
}

export function submitOnCtrlEnter(form, button) {
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      button.click()
    }
  })
}

function replyBox(latest, onDone) {
  const files = []
  const text = h('textarea', {
    required: true,
    placeholder: '写回复…',
    'aria-label': '回复内容',
  })
  const cc = h('input', {
    type: 'text',
    placeholder: '可选，多个地址用逗号分隔',
  })
  const create = async () => {
    const ccList = addressList(cc.value, '抄送')
    if (!text.value.trim()) throw new Error('回复内容不能为空')
    return api('drafts.create', {
      messageId: latest.id,
      text: text.value,
      ...(ccList.length ? { cc: ccList } : {}),
      ...(files.length ? { attachments: payloadAttachments(files) } : {}),
      source: 'manual',
    })
  }
  const { sendBtn, saveBtn } = sendControls(
    create,
    (draft) => [draft.recipient, ...(draft.cc ?? [])],
    onDone,
  )
  const box = h(
    'div',
    { class: 'reply-box form' },
    h('h3', {}, `回复 ${latest.from}`),
    h('div', { class: 'field' }, h('label', {}, '抄送'), cc),
    h('div', { class: 'field' }, text),
    attachmentPicker(files),
    h(
      'div',
      { class: 'actions' },
      h('span', { class: 'spacer' }),
      saveBtn,
      sendBtn,
    ),
  )
  submitOnCtrlEnter(box, sendBtn)
  return box
}

function forwardBox(message, onDone) {
  const to = h('input', {
    type: 'text',
    required: true,
    placeholder: 'name@example.com，多个用逗号分隔',
  })
  const cc = h('input', { type: 'text', placeholder: '可选' })
  const note = h('textarea', {
    placeholder: '可选：写几句附言，原邮件会附在下面',
    style: 'min-height:110px',
  })
  const count = message.attachments?.length ?? 0
  const withFiles = h('input', { type: 'checkbox', checked: count > 0 })
  const create = async () => {
    const toList = addressList(to.value, '收件人', { required: true })
    const ccList = addressList(cc.value, '抄送')
    return api('drafts.forward', {
      messageId: message.id,
      to: toList,
      ...(ccList.length ? { cc: ccList } : {}),
      ...(note.value.trim() ? { note: note.value.trim() } : {}),
      includeAttachments: count > 0 && withFiles.checked,
      source: 'manual',
    })
  }
  const { sendBtn, saveBtn } = sendControls(
    create,
    (draft) => [...draft.to, ...(draft.cc ?? [])],
    onDone,
    (draft) =>
      draft.attachmentCount ? [`附带 ${draft.attachmentCount} 个原附件。`] : [],
  )
  const box = h(
    'div',
    { class: 'reply-box form' },
    h('h3', {}, `转发：${message.subject || '（无主题）'}`),
    h('div', { class: 'field' }, h('label', {}, '收件人'), to),
    h('div', { class: 'field' }, h('label', {}, '抄送'), cc),
    h('div', { class: 'field' }, h('label', {}, '附言'), note),
    count
      ? h(
          'label',
          { class: 'check' },
          withFiles,
          `附带原邮件的 ${count} 个附件`,
        )
      : null,
    h(
      'div',
      { class: 'actions' },
      h(
        'span',
        { class: 'hint' },
        '原邮件的发件人、时间和正文会附在附言下面。',
      ),
      h('span', { class: 'spacer' }),
      saveBtn,
      sendBtn,
    ),
  )
  submitOnCtrlEnter(box, sendBtn)
  return box
}

function toolbarButton(label, iconName, key, onclick, primary = false) {
  return h(
    'button',
    {
      class: `btn${primary ? ' primary' : ''}`,
      type: 'button',
      title: `${label}（${key === 'U' ? 'Shift+U' : key}）`,
      'data-key': key,
      onclick,
    },
    icon(iconName),
    h('span', { class: 'label' }, label),
  )
}

export function threadPane(threadId) {
  return lazyPane('read-pane', async () => {
    const data = await api('messages.thread', {
      threadId,
      includeBodies: true,
      limit: 50,
    })
    const messages = data.messages
    const unread = messages.filter((item) => item.status === 'unread')
    if (unread.length) {
      Promise.all(
        unread.map((item) =>
          api('messages.update', { id: item.id, status: 'read' }),
        ),
      )
        .then(refreshCounts)
        .catch(() => undefined)
      for (const row of document.querySelectorAll('.list .row.active')) {
        row.classList.remove('unread')
        row.dataset.status = 'read'
      }
    }
    const from = parseRoute().params.get('from') || 'inbox'
    const latest = messages.at(-1)
    const latestInbound = [...messages]
      .reverse()
      .find((item) => item.direction === 'inbound')
    const composer = h('div')
    const open = (box) => {
      composer.replaceChildren(box)
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      box.querySelector('input, textarea')?.focus()
    }
    const forward = (message) => open(forwardBox(message, () => route()))
    const setStatus = (status, label) => async (event) => {
      await withBusy(event.currentTarget, async () => {
        await Promise.all(
          messages
            .filter((item) => item.direction === 'inbound')
            .map((item) => api('messages.update', { id: item.id, status })),
        )
        toast(label)
        await refreshCounts()
        go(from)
      })
    }
    const unreadCount = unread.length
    return h(
      'section',
      { class: 'read-pane' },
      h(
        'div',
        { class: 'read-inner' },
        h(
          'div',
          { class: 'toolbar', role: 'toolbar', 'aria-label': '邮件操作' },
          backButton(`#/${from}`),
          latestInbound
            ? toolbarButton(
                '回复',
                'reply',
                'r',
                () => open(replyBox(latestInbound, () => route())),
                true,
              )
            : null,
          latest
            ? toolbarButton('转发', 'forward', 'f', () =>
                forward(latestInbound ?? latest),
              )
            : null,
          latestInbound
            ? toolbarButton(
                '归档',
                'archive',
                'e',
                setStatus('archived', '已归档'),
              )
            : null,
          latestInbound
            ? toolbarButton(
                '垃圾邮件',
                'spam',
                '#',
                setStatus('spam', '已标为垃圾邮件'),
              )
            : null,
          latestInbound
            ? toolbarButton('标为未读', 'unread', 'U', async (event) =>
                withBusy(event.currentTarget, async () => {
                  await api('messages.update', {
                    id: latestInbound.id,
                    status: 'unread',
                  })
                  toast('已标为未读')
                  await refreshCounts()
                  go(from)
                }),
              )
            : null,
        ),
        h('h1', { class: 'thread-title' }, latest?.subject || '（无主题）'),
        h('span', { class: 'title-rule' }),
        messages.map((message, index) =>
          messageCard(message, {
            collapsed:
              messages.length > 1 &&
              index < messages.length - 1 &&
              !(unreadCount && message.status === 'unread'),
            onForward: forward,
          }),
        ),
        composer,
      ),
    )
  })
}
