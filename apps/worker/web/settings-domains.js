// Part of the Mailroom web app. See app.js. Settings: domains, mailbox
// addresses and the routes that deliver mail to them.

import { loadInboxes, route } from './app.js'
import {
  api,
  confirmDialog,
  h,
  icon,
  toast,
  validEmail,
  withBusy,
} from './lib.js'

function statusBadge(enabled) {
  return h(
    'span',
    { class: `badge ${enabled ? 'ok' : 'warn'}` },
    enabled ? '启用' : '停用',
  )
}

async function refresh(message) {
  if (message) toast(message)
  await loadInboxes()
  route()
}

function optionalEmail(input, label) {
  const value = input.value.trim().toLowerCase()
  if (value && !validEmail(value)) throw new Error(`${label}格式不正确`)
  return value || null
}

function domainCard(domain, inboxes, routes) {
  const fromAddress = h('input', {
    type: 'email',
    value: domain.fromAddress ?? '',
    placeholder: '留空则用收件地址回复',
  })
  const replyTo = h('input', {
    type: 'email',
    value: domain.replyTo ?? '',
    placeholder: '可选',
  })
  const saveDomain = h('button', { class: 'btn small', type: 'button' }, '保存')
  saveDomain.addEventListener('click', () =>
    withBusy(saveDomain, async () => {
      await api('domains.upsert', {
        id: domain.id,
        domain: domain.domain,
        fromAddress: optionalEmail(fromAddress, '回复发件地址'),
        replyTo: optionalEmail(replyTo, 'Reply-To'),
        enabled: domain.enabled,
      })
      await refresh('已保存')
    }),
  )
  const toggleDomain = h(
    'button',
    { class: `btn small${domain.enabled ? ' danger' : ''}`, type: 'button' },
    domain.enabled ? '停用域名' : '启用域名',
  )
  toggleDomain.addEventListener('click', async () => {
    if (
      domain.enabled &&
      !(await confirmDialog(
        `停用 ${domain.domain}？`,
        ['停用后这个域名不再收信，也不能从它发信。已有邮件会保留。'],
        '停用',
      ))
    )
      return
    await withBusy(toggleDomain, async () => {
      await api('domains.upsert', {
        id: domain.id,
        domain: domain.domain,
        enabled: !domain.enabled,
      })
      await refresh(domain.enabled ? '已停用' : '已启用')
    })
  })

  const catchall = routes.find((item) => item.kind === 'catchall')
  const exactFor = (inbox) =>
    routes.find((item) => item.kind === 'exact' && item.inboxId === inbox.id)

  const inboxRows = inboxes.map((inbox) => {
    const exact = exactFor(inbox)
    const toggle = h(
      'button',
      { class: 'btn small ghost', type: 'button' },
      inbox.enabled ? '停用' : '启用',
    )
    toggle.addEventListener('click', () =>
      withBusy(toggle, async () => {
        await api('inboxes.upsert', {
          id: inbox.id,
          domain: domain.domain,
          localPart: inbox.localPart,
          name: inbox.name || inbox.localPart,
          enabled: !inbox.enabled,
        })
        await refresh(inbox.enabled ? '已停用' : '已启用')
      }),
    )
    const routeButton = exact
      ? h(
          'button',
          {
            class: 'btn small ghost',
            type: 'button',
            title: '删除这条路由后，发到这个地址的信只有兜底规则才会收下',
            onclick: async (event) => {
              const button = event.currentTarget
              if (
                !(await confirmDialog(
                  `不再收 ${inbox.address} 的信？`,
                  [
                    '会删除这个地址的收信路由。已有邮件会保留，随时可以重新开启。',
                  ],
                  '删除路由',
                ))
              )
                return
              await withBusy(button, async () => {
                await api('routes.delete', { id: exact.id })
                await refresh('已删除路由')
              })
            },
          },
          '停止收信',
        )
      : h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            onclick: (event) =>
              withBusy(event.currentTarget, async () => {
                await api('routes.upsert', {
                  inboxId: inbox.id,
                  domain: domain.domain,
                  kind: 'exact',
                  localPart: inbox.localPart,
                  enabled: true,
                  priority: 100,
                })
                await refresh('已开始收信')
              }),
          },
          '开始收信',
        )
    return h(
      'tr',
      {},
      h('td', {}, h('strong', {}, inbox.address)),
      h('td', {}, inbox.name ?? ''),
      h(
        'td',
        {},
        statusBadge(inbox.enabled),
        ' ',
        exact
          ? ''
          : h(
              'span',
              { class: 'badge' },
              catchall?.inboxId === inbox.id ? '兜底' : '不收信',
            ),
      ),
      h('td', { class: 'actions-cell' }, routeButton, toggle),
    )
  })

  const localPart = h('input', {
    type: 'text',
    placeholder: '例如 hello',
    autocapitalize: 'off',
    spellcheck: 'false',
  })
  const name = h('input', { type: 'text', placeholder: '显示名称，可选' })
  const add = h(
    'button',
    { class: 'btn primary', type: 'button' },
    icon('plus'),
    '添加邮箱',
  )
  add.addEventListener('click', () =>
    withBusy(add, async () => {
      const part = localPart.value.trim().toLowerCase()
      if (!/^[a-z0-9._+-]{1,64}$/.test(part)) {
        throw new Error('地址前缀只能用字母、数字和 . _ + -')
      }
      const inbox = await api('inboxes.upsert', {
        domain: domain.domain,
        localPart: part,
        name: name.value.trim() || part,
        enabled: true,
      })
      await api('routes.upsert', {
        inboxId: inbox.id,
        domain: domain.domain,
        kind: 'exact',
        localPart: part,
        enabled: true,
        priority: 100,
      })
      await refresh(`已添加 ${inbox.address}`)
    }),
  )

  const catchallSelect = h(
    'select',
    {},
    h('option', { value: '' }, '不收（退回或丢弃）'),
    inboxes
      .filter((inbox) => inbox.enabled)
      .map((inbox) =>
        h(
          'option',
          { value: inbox.id, selected: catchall?.inboxId === inbox.id },
          `收进 ${inbox.address}`,
        ),
      ),
  )
  catchallSelect.addEventListener('change', () =>
    withBusy(catchallSelect, async () => {
      if (!catchallSelect.value) {
        if (catchall) await api('routes.delete', { id: catchall.id })
      } else {
        await api('routes.upsert', {
          ...(catchall ? { id: catchall.id } : {}),
          inboxId: catchallSelect.value,
          domain: domain.domain,
          kind: 'catchall',
          localPart: null,
          enabled: true,
          priority: 1000,
        })
      }
      await refresh('已更新兜底规则')
    }),
  )

  return h(
    'div',
    { class: 'card accent' },
    h(
      'h3',
      {},
      domain.domain,
      statusBadge(domain.enabled),
      h('span', { class: 'spacer' }),
      toggleDomain,
    ),
    inboxes.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'tbl' },
            h(
              'tr',
              {},
              h('th', {}, '地址'),
              h('th', {}, '名称'),
              h('th', {}, '状态'),
              h('th', {}),
            ),
            inboxRows,
          ),
        )
      : h('p', { class: 'hint' }, '这个域名下还没有邮箱地址。'),
    domain.enabled
      ? h(
          'div',
          { class: 'field-row', style: 'margin-top:14px;align-items:end' },
          h(
            'div',
            { class: 'field' },
            h('label', {}, `新地址 @${domain.domain}`),
            localPart,
          ),
          h('div', { class: 'field' }, h('label', {}, '名称'), name),
          h('div', { class: 'field' }, add),
        )
      : null,
    h('h4', {}, '其他地址的信'),
    h(
      'div',
      { class: 'field' },
      catchallSelect,
      h('p', { class: 'hint' }, '发到这个域名下没有列出的地址时怎么处理。'),
    ),
    h('h4', {}, '发信'),
    h(
      'div',
      { class: 'field-row', style: 'align-items:end' },
      h(
        'div',
        { class: 'field' },
        h('label', {}, '回复时的发件地址'),
        fromAddress,
      ),
      h('div', { class: 'field' }, h('label', {}, 'Reply-To'), replyTo),
      h('div', { class: 'field' }, saveDomain),
    ),
  )
}

export async function domainsSection() {
  const [domains, inboxes, routes] = await Promise.all([
    api('domains.list', { limit: 100 }),
    api('inboxes.list', { limit: 100 }),
    api('routes.list', { limit: 100 }),
  ])
  const newDomain = h('input', {
    type: 'text',
    placeholder: 'example.com',
    autocapitalize: 'off',
    spellcheck: 'false',
  })
  const add = h(
    'button',
    { class: 'btn primary', type: 'button' },
    icon('plus'),
    '添加域名',
  )
  add.addEventListener('click', () =>
    withBusy(add, async () => {
      const value = newDomain.value.trim().toLowerCase()
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) {
        throw new Error('请输入域名，例如 example.com')
      }
      await api('domains.upsert', { domain: value, enabled: true })
      await refresh(`已添加 ${value}，接着给它添加邮箱地址`)
    }),
  )
  const byDomain = (list, domain) =>
    list.items
      .filter(
        (item) => item.domainId === domain.id || item.domain === domain.domain,
      )
      .sort((a, b) =>
        String(a.address ?? '').localeCompare(String(b.address ?? '')),
      )
  return [
    ...domains.items
      .sort((a, b) => a.domain.localeCompare(b.domain))
      .map((domain) =>
        domainCard(domain, byDomain(inboxes, domain), byDomain(routes, domain)),
      ),
    h(
      'div',
      { class: 'card form' },
      h('h3', {}, '添加域名'),
      h(
        'div',
        { class: 'copy-row', style: 'margin:0' },
        h('div', { class: 'field', style: 'flex:1' }, newDomain),
        add,
      ),
      h(
        'p',
        { class: 'hint' },
        '在这里添加后，还要在 Cloudflare 完成两步：Email Routing 里把这个域名的收信规则指向 mailroom Worker；如果要从它发信，在 Email Sending 里开通该域名，并把发件地址加进 Worker 的发信绑定。',
      ),
    ),
  ]
}
