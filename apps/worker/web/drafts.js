// Part of the Mailroom web app. See app.js.

import { loadInboxes, route } from './app.js'
import { backButton, menuButton } from './layout.js'
import {
  api,
  confirmDialog,
  fullDate,
  go,
  h,
  promptDialog,
  shortDate,
  splitAddresses,
  state,
  toast,
  validEmail,
  withBusy,
} from './lib.js'
import {
  approveAndSend,
  attachmentChips,
  attachmentPicker,
  payloadAttachments,
} from './mail.js'

/* ---------- compose ---------- */

export async function composePane() {
  if (!state.inboxes.length) await loadInboxes()
  const files = []
  const fromSelect = h(
    'select',
    { required: true },
    state.inboxes.map((inbox) =>
      h(
        'option',
        { value: inbox.id, selected: inbox.id === state.box },
        inbox.address,
      ),
    ),
  )
  const to = h('input', {
    type: 'text',
    required: true,
    placeholder: 'name@example.com，多个用逗号分隔',
  })
  const cc = h('input', { type: 'text', placeholder: '可选' })
  const subject = h('input', { type: 'text', required: true, maxlength: 998 })
  const text = h('textarea', { required: true })
  const sendBtn = h('button', { class: 'btn primary', type: 'button' }, '发送')
  const saveBtn = h('button', { class: 'btn', type: 'button' }, '存为草稿')
  const create = async () => {
    if (!fromSelect.value)
      throw new Error('还没有可用的发件邮箱，请先在 Mailroom 中配置域名和邮箱')
    const toList = splitAddresses(to.value)
    const ccList = splitAddresses(cc.value)
    const bad = [...toList, ...ccList].find((item) => !validEmail(item))
    if (!toList.length) throw new Error('请填写收件人')
    if (bad) throw new Error(`邮箱地址不正确：${bad}`)
    if (!subject.value.trim()) throw new Error('请填写主题')
    if (!text.value.trim()) throw new Error('正文不能为空')
    return api('drafts.compose', {
      inboxId: fromSelect.value,
      to: toList,
      ...(ccList.length ? { cc: ccList } : {}),
      subject: subject.value.trim(),
      text: text.value,
      ...(files.length ? { attachments: payloadAttachments(files) } : {}),
      source: 'manual',
    })
  }
  saveBtn.addEventListener('click', () =>
    withBusy(saveBtn, async () => {
      const draft = await create()
      toast('草稿已保存')
      go(`draft/${encodeURIComponent(draft.id)}`)
    }),
  )
  sendBtn.addEventListener('click', () =>
    withBusy(sendBtn, async () => {
      const draft = await create()
      const sent = await approveAndSend(draft.id, [
        ...draft.to,
        ...(draft.cc ?? []),
      ])
      toast(sent ? '已发送' : '已存为草稿，未发送')
      go(sent ? 'sent' : `draft/${encodeURIComponent(draft.id)}`)
    }),
  )
  return h(
    'section',
    { class: 'read-pane' },
    h(
      'div',
      { class: 'read-inner' },
      h('div', { class: 'toolbar' }, menuButton(), backButton('#/inbox')),
      h('h1', { class: 'thread-title' }, '写邮件'),
      h(
        'form',
        { class: 'form', onsubmit: (event) => event.preventDefault() },
        h('div', { class: 'field' }, h('label', {}, '发件人'), fromSelect),
        h('div', { class: 'field' }, h('label', {}, '收件人'), to),
        h('div', { class: 'field' }, h('label', {}, '抄送'), cc),
        h('div', { class: 'field' }, h('label', {}, '主题'), subject),
        h('div', { class: 'field' }, h('label', {}, '正文'), text),
        attachmentPicker(files),
        h(
          'div',
          { class: 'actions' },
          h('span', { class: 'hint' }, '发送前会再确认一次收件人。'),
          h('span', { class: 'spacer' }),
          saveBtn,
          sendBtn,
        ),
      ),
    ),
  )
}

/* ---------- drafts ---------- */

export const DRAFT_STATUS = {
  pending: '待审批',
  approved: '已批准',
  sent: '已发送',
  failed: '发送失败',
  rejected: '已拒绝',
  sending: '发送中',
}

export async function draftsListPane(activeId) {
  const list = h('div', { class: 'list' })
  const tabs = h(
    'div',
    { class: 'tabs' },
    ['pending', 'approved', 'failed', 'sent', 'rejected'].map((status) =>
      h(
        'button',
        {
          class: `tab${state.draftTab === status ? ' active' : ''}`,
          onclick: () => {
            state.draftTab = status
            route()
          },
        },
        DRAFT_STATUS[status],
      ),
    ),
  )
  const result = await api('drafts.list', { status: state.draftTab, limit: 50 })
  if (!result.items.length)
    list.append(h('div', { class: 'empty' }, '没有草稿'))
  for (const draft of result.items) {
    list.append(
      h(
        'a',
        {
          class: `row${draft.id === activeId ? ' active' : ''}`,
          href: `#/draft/${encodeURIComponent(draft.id)}`,
        },
        h(
          'div',
          { class: 'row-top' },
          h(
            'span',
            { class: 'row-from' },
            `发给 ${(draft.to ?? [draft.recipient]).join(', ')}`,
          ),
          h('span', {}, shortDate(draft.createdAt)),
        ),
        h(
          'div',
          { class: 'row-subject' },
          draft.subject,
          draft.attachmentCount ? h('span', { class: 'clip' }, '📎') : null,
        ),
        h(
          'div',
          { class: 'row-preview' },
          `${draft.kind === 'new' ? '新邮件' : '回复'} · 来源：${draft.source}`,
        ),
      ),
    )
  }
  return h(
    'section',
    { class: 'list-pane' },
    h('div', { class: 'pane-head' }, menuButton(), h('h2', {}, '草稿与审批')),
    h('div', { class: 'pane-head', style: 'min-height:44px' }, tabs),
    list,
  )
}

export async function draftPane(id) {
  const draft = await api('drafts.get', { id })
  const recipients = [...(draft.to ?? [draft.recipient]), ...(draft.cc ?? [])]
  const actions = h('div', { class: 'toolbar' }, backButton('#/drafts'))
  if (draft.status === 'pending' || draft.status === 'approved') {
    actions.append(
      h(
        'button',
        {
          class: 'btn primary',
          onclick: (event) =>
            withBusy(event.currentTarget, async () => {
              const ok = await confirmDialog(
                '确认发送？',
                [`发给：${recipients.join(', ')}`, '发出后无法撤回。'],
                '发送',
              )
              if (!ok) return
              if (draft.status === 'pending') {
                await api('drafts.approve', { id, approvedBy: 'owner (web)' })
              }
              await api('drafts.send', {
                id,
                idempotencyKey: `web-${crypto.randomUUID()}`,
              })
              toast('已发送')
              route()
            }),
        },
        draft.status === 'pending' ? '批准并发送' : '发送',
      ),
    )
    if (draft.status === 'pending') {
      actions.append(
        h(
          'button',
          {
            class: 'btn',
            onclick: (event) =>
              withBusy(event.currentTarget, async () => {
                await api('drafts.approve', { id, approvedBy: 'owner (web)' })
                toast('已批准，尚未发送')
                route()
              }),
          },
          '仅批准',
        ),
      )
    }
    actions.append(
      h(
        'button',
        {
          class: 'btn danger',
          onclick: async (event) => {
            const reason = await promptDialog('拒绝这份草稿', '原因')
            if (!reason) return
            await withBusy(event.currentTarget, async () => {
              await api('drafts.reject', {
                id,
                rejectedBy: 'owner (web)',
                reason,
              })
              toast('已拒绝')
              route()
            })
          },
        },
        '拒绝',
      ),
    )
  }
  return h(
    'section',
    { class: 'read-pane' },
    h(
      'div',
      { class: 'read-inner' },
      actions,
      h('h1', { class: 'thread-title' }, draft.subject),
      h(
        'div',
        { class: 'card' },
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, '状态'),
          h(
            'dd',
            {},
            h(
              'span',
              {
                class: `badge${draft.status === 'sent' ? ' ok' : draft.status === 'failed' ? ' bad' : ''}`,
              },
              DRAFT_STATUS[draft.status] ?? draft.status,
            ),
          ),
          h('dt', {}, '发件人'),
          h('dd', {}, draft.sender),
          h('dt', {}, '收件人'),
          h('dd', {}, (draft.to ?? [draft.recipient]).join(', ')),
          draft.cc?.length
            ? [h('dt', {}, '抄送'), h('dd', {}, draft.cc.join(', '))]
            : null,
          h('dt', {}, '类型'),
          h('dd', {}, draft.kind === 'new' ? '新邮件' : '回复'),
          h('dt', {}, '来源'),
          h('dd', {}, draft.source),
          draft.lastError
            ? [
                h('dt', {}, '错误'),
                h('dd', { class: 'error' }, draft.lastError),
              ]
            : null,
        ),
      ),
      h(
        'article',
        { class: 'msg' },
        h(
          'div',
          { class: 'msg-body' },
          h('pre', { class: 'msg-text' }, draft.text),
        ),
        attachmentChips(draft.attachments),
      ),
      draft.threadId && draft.status === 'sent'
        ? h(
            'a',
            {
              class: 'btn',
              href: `#/thread/${encodeURIComponent(draft.threadId)}?from=sent`,
            },
            '查看会话',
          )
        : null,
      h(
        'div',
        { class: 'card' },
        h('h3', {}, '记录'),
        h(
          'table',
          { class: 'tbl' },
          h(
            'tr',
            {},
            h('th', {}, '时间'),
            h('th', {}, '动作'),
            h('th', {}, '操作者'),
            h('th', {}, '备注'),
          ),
          (draft.events ?? []).map((event) =>
            h(
              'tr',
              {},
              h('td', {}, fullDate(event.createdAt)),
              h('td', {}, event.action),
              h('td', {}, event.actor),
              h('td', {}, event.note ?? ''),
            ),
          ),
        ),
      ),
    ),
  )
}
