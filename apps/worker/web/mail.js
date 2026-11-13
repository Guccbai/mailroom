// Part of the Mailroom web app. See app.js.

import { route } from './app.js'
import { backButton, menuButton } from './layout.js'
import {
  api,
  bytes,
  confirmDialog,
  downloadUrl,
  fullDate,
  go,
  h,
  MAX_ATTACHMENT_BYTES,
  parseRoute,
  readFile,
  shortDate,
  splitAddresses,
  state,
  toast,
  validEmail,
  withBusy,
} from './lib.js'

/* ---------- message lists ---------- */

export function listParams(name) {
  const base = state.box ? { inboxId: state.box } : {}
  if (name === 'inbox')
    return { ...base, direction: 'inbound', statuses: ['unread', 'read'] }
  if (name === 'sent') return { ...base, direction: 'outbound' }
  if (name === 'archived') return { ...base, status: 'archived' }
  if (name === 'spam') return { ...base, status: 'spam' }
  return base
}

export function messageRow(item, activeThread) {
  return h(
    'a',
    {
      class: `row${item.status === 'unread' ? ' unread' : ''}${item.threadId === activeThread ? ' active' : ''}`,
      href: `#/thread/${encodeURIComponent(item.threadId)}?from=${parseRoute().name}`,
    },
    h(
      'div',
      { class: 'row-top' },
      h(
        'span',
        { class: 'row-from' },
        item.direction === 'outbound'
          ? `发给 ${(item.to ?? []).join(', ')}`
          : item.from,
      ),
      h('span', {}, shortDate(item.receivedAt)),
    ),
    h(
      'div',
      { class: 'row-subject' },
      item.subject || '（无主题）',
      item.hasAttachments
        ? h('span', { class: 'clip', title: '有附件' }, '📎')
        : null,
    ),
    h('div', { class: 'row-preview' }, item.preview || item.snippet || ''),
  )
}

export async function messageListPane(name, title, activeThread) {
  const list = h('div', { class: 'list' })
  const search = h('input', {
    class: 'search',
    type: 'search',
    placeholder: '搜索邮件',
    value: name === 'search' ? (parseRoute().params.get('q') ?? '') : '',
    onkeydown: (event) => {
      if (event.key === 'Enter' && search.value.trim().length >= 2) {
        go(`search?q=${encodeURIComponent(search.value.trim())}`)
      }
    },
  })
  const pane = h(
    'section',
    { class: 'list-pane' },
    h('div', { class: 'pane-head' }, menuButton(), search),
    h(
      'div',
      { class: 'pane-head', style: 'min-height:44px;padding:8px 14px' },
      h('h2', {}, title),
    ),
    list,
  )
  if (name === 'search') {
    const query = parseRoute().params.get('q') ?? ''
    const result = await api('messages.search', { query, limit: 30 })
    if (!result.items.length)
      list.append(h('div', { class: 'empty' }, '没有找到相关邮件'))
    for (const item of result.items) {
      list.append(
        messageRow(
          {
            threadId: item.threadId ?? item.metadata?.threadId,
            subject: item.subject ?? '',
            from: item.from ?? '',
            receivedAt: item.receivedAt ?? item.metadata?.received_at,
            snippet: item.snippet,
            status: 'read',
          },
          activeThread,
        ),
      )
    }
    return pane
  }
  let cursor
  const load = async () => {
    const result = await api('messages.list', {
      ...listParams(name),
      limit: 40,
      ...(cursor ? { cursor } : {}),
    })
    list.querySelector('.more')?.remove()
    if (!result.items.length && !cursor)
      list.append(h('div', { class: 'empty' }, '这里还没有邮件'))
    for (const item of result.items) list.append(messageRow(item, activeThread))
    cursor = result.nextCursor
    if (cursor) {
      const more = h('button', { class: 'btn more' }, '加载更多')
      more.addEventListener('click', () => withBusy(more, load))
      list.append(more)
    }
    if (name === 'inbox' && !result.items.length) state.counts.inbox = 0
  }
  await load()
  return pane
}

export async function refreshCounts() {
  try {
    const [unread, drafts] = await Promise.all([
      api('messages.list', {
        direction: 'inbound',
        status: 'unread',
        limit: 100,
      }),
      api('drafts.list', { status: 'pending', limit: 100 }),
    ])
    state.counts.inbox =
      unread.items.length >= 100 ? '99+' : unread.items.length || ''
    state.counts.drafts = drafts.items.length || ''
  } catch {
    // Counts are decorative; ignore failures.
  }
}

/* ---------- reading ---------- */

export function mailFrame(html, allowImages) {
  const policy = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: cid:${allowImages ? ' https: http:' : ''}`
  const frame = h('iframe', {
    class: 'mail-frame',
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    referrerpolicy: 'no-referrer',
    title: '邮件内容',
  })
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base target="_blank"><style>html{color-scheme:light}body{margin:0;padding:4px;font:14px/1.55 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1c1c1a;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${html}</body></html>`
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
  const draw = () => {
    const controls = h('div', { class: 'body-switch' })
    if (hasHtml && message.text) {
      controls.append(
        h(
          'button',
          {
            class: `tab${mode === 'html' ? ' active' : ''}`,
            onclick: () => {
              mode = 'html'
              draw()
            },
          },
          '原样式',
        ),
        h(
          'button',
          {
            class: `tab${mode === 'text' ? ' active' : ''}`,
            onclick: () => {
              mode = 'text'
              draw()
            },
          },
          '纯文本',
        ),
      )
    }
    if (mode === 'html' && !allowImages) {
      controls.append(
        h(
          'button',
          {
            class: 'tab',
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
        : h('pre', { class: 'msg-text' }, message.text || ''),
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
        '📎',
        h('span', {}, attachment.filename || '未命名文件'),
        h('small', {}, bytes(attachment.sizeBytes)),
      ),
    ),
  )
}

export function messageCard(message) {
  const outbound = message.direction === 'outbound'
  return h(
    'article',
    { class: `msg${outbound ? ' outbound' : ''}` },
    h(
      'div',
      { class: 'msg-head' },
      h(
        'div',
        { class: 'msg-meta' },
        h('div', {}, h('strong', {}, message.from)),
        h('div', {}, `收件人：${(message.to ?? []).join(', ')}`),
        message.cc?.length
          ? h('div', {}, `抄送：${message.cc.join(', ')}`)
          : null,
      ),
      h('div', { class: 'msg-date' }, fullDate(message.receivedAt)),
    ),
    messageBody(message),
    attachmentChips(message.attachments),
  )
}

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
          '📎',
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
        toast('最多 10 个附件')
        break
      }
      if (total() + file.size > MAX_ATTACHMENT_BYTES) {
        toast('附件合计不能超过 10 MB')
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

export async function approveAndSend(draftId, recipients) {
  const ok = await confirmDialog(
    '确认发送？',
    [`发给：${recipients.join(', ')}`, '发出后无法撤回。'],
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

export function replyBox(latest, onDone) {
  const files = []
  const text = h('textarea', { required: true, placeholder: '写回复…' })
  const cc = h('input', {
    type: 'text',
    placeholder: '可选，多个地址用逗号分隔',
  })
  const sendBtn = h('button', { class: 'btn primary', type: 'button' }, '发送')
  const saveBtn = h('button', { class: 'btn', type: 'button' }, '存为草稿')
  const create = async () => {
    const ccList = splitAddresses(cc.value)
    const bad = ccList.find((item) => !validEmail(item))
    if (bad) throw new Error(`抄送地址不正确：${bad}`)
    if (!text.value.trim()) throw new Error('回复内容不能为空')
    return api('drafts.create', {
      messageId: latest.id,
      text: text.value,
      ...(ccList.length ? { cc: ccList } : {}),
      ...(files.length ? { attachments: payloadAttachments(files) } : {}),
      source: 'manual',
    })
  }
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
      const sent = await approveAndSend(draft.id, [
        draft.recipient,
        ...(draft.cc ?? []),
      ])
      if (sent) {
        toast('已发送')
        onDone()
      } else {
        toast('已存为草稿，未发送')
        go(`draft/${encodeURIComponent(draft.id)}`)
      }
    }),
  )
  return h(
    'div',
    { class: 'reply-box form' },
    h('div', { class: 'hint' }, `回复 ${latest.from}`),
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
}

export async function threadPane(threadId) {
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
  }
  const latestInbound = [...messages]
    .reverse()
    .find((item) => item.direction === 'inbound')
  const replyHolder = h('div')
  const setStatus = (status, label) => async (event) => {
    await withBusy(event.currentTarget, async () => {
      await Promise.all(
        messages
          .filter((item) => item.direction === 'inbound')
          .map((item) => api('messages.update', { id: item.id, status })),
      )
      toast(label)
      go(parseRoute().params.get('from') || 'inbox')
    })
  }
  const from = parseRoute().params.get('from') || 'inbox'
  return h(
    'section',
    { class: 'read-pane' },
    h(
      'div',
      { class: 'read-inner' },
      h(
        'div',
        { class: 'toolbar' },
        backButton(`#/${from}`),
        latestInbound
          ? h(
              'button',
              {
                class: 'btn primary',
                onclick: () => {
                  replyHolder.replaceChildren(
                    replyBox(latestInbound, () => route()),
                  )
                  replyHolder.querySelector('textarea')?.focus()
                },
              },
              '回复',
            )
          : null,
        h(
          'button',
          { class: 'btn', onclick: setStatus('archived', '已归档') },
          '归档',
        ),
        h(
          'button',
          { class: 'btn', onclick: setStatus('spam', '已标为垃圾邮件') },
          '垃圾邮件',
        ),
        latestInbound
          ? h(
              'button',
              {
                class: 'btn',
                onclick: async (event) =>
                  withBusy(event.currentTarget, async () => {
                    await api('messages.update', {
                      id: latestInbound.id,
                      status: 'unread',
                    })
                    toast('已标为未读')
                    go(from)
                  }),
              },
              '标为未读',
            )
          : null,
      ),
      h(
        'h1',
        { class: 'thread-title' },
        messages.at(-1)?.subject || '（无主题）',
      ),
      messages.map(messageCard),
      replyHolder,
    ),
  )
}
