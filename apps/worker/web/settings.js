// Part of the Mailroom web app. See app.js. The settings page and its
// general sections; domains and MCP live in their own modules.

import { route } from './app.js'
import { menuButton, renderLogin } from './layout.js'
import {
  api,
  go,
  h,
  icon,
  readPref,
  request,
  setTheme,
  shortDate,
  state,
  THEMES,
  toast,
  withBusy,
} from './lib.js'
import { domainsSection } from './settings-domains.js'
import { mcpSection } from './settings-mcp.js'

export const SETTINGS_TABS = [
  ['overview', '概览'],
  ['domains', '域名与邮箱'],
  ['notifications', '通知'],
  ['forwarding', '转发'],
  ['mcp', 'MCP 与令牌'],
  ['account', '账号与外观'],
]

export function badge(ok, yes = '已配置', no = '未配置') {
  return h('span', { class: `badge ${ok ? 'ok' : 'warn'}` }, ok ? yes : no)
}

const SOURCE_LABEL = {
  web: '网页设置',
  worker: 'Worker 变量',
  unset: '未设置',
}

export async function loadSettings() {
  const result = await api('settings.get')
  return Object.fromEntries(result.items.map((item) => [item.key, item]))
}

/**
 * One stored setting. read() returns undefined when nothing changed, null to
 * clear the stored value, or the new string.
 */
export function settingInput(
  item,
  { label, hint, placeholder, type = 'text' },
) {
  const secret = item.secret
  const original = secret ? '' : (item.value ?? '')
  let cleared = false
  const input = h('input', {
    type: secret ? 'password' : type,
    autocomplete: 'off',
    spellcheck: 'false',
    value: original,
    placeholder:
      secret && item.configured ? '已设置，留空则不修改' : (placeholder ?? ''),
  })
  const clear =
    item.source === 'web'
      ? h(
          'button',
          {
            class: 'btn small ghost',
            type: 'button',
            title:
              secret || item.value
                ? '删除网页里存的值，恢复使用 Worker 变量'
                : '',
            onclick: () => {
              cleared = true
              input.value = ''
              input.placeholder = '保存后清除'
            },
          },
          '清除',
        )
      : null
  const element = h(
    'div',
    { class: 'field' },
    h(
      'label',
      {},
      label,
      ' ',
      h('span', { class: 'source' }, `· ${SOURCE_LABEL[item.source] ?? ''}`),
    ),
    clear
      ? h('div', { class: 'copy-row', style: 'margin:0' }, input, clear)
      : input,
    hint ? h('p', { class: 'hint' }, hint) : null,
  )
  const read = () => {
    const value = input.value.trim()
    if (cleared && !value) return null
    if (secret) return value ? value : undefined
    if (value === original.trim()) return undefined
    return value ? value : item.source === 'web' ? null : undefined
  }
  return { element, read }
}

export async function saveSettings(button, readers, extra = {}) {
  const values = { ...extra }
  for (const [key, read] of Object.entries(readers)) {
    const value = read()
    if (value !== undefined) values[key] = value
  }
  if (!Object.keys(values).length) {
    toast('没有改动')
    return
  }
  await withBusy(button, async () => {
    await api('settings.update', { values })
    toast('已保存')
    route()
  })
}

export function mailboxChecks(selected, { allLabel } = {}) {
  const all = selected.includes('*')
  const boxes = state.inboxes.map((inbox) => ({
    address: inbox.address,
    input: h('input', {
      type: 'checkbox',
      checked: all || selected.includes(inbox.address),
      disabled: all,
    }),
  }))
  const allBox = h('input', {
    type: 'checkbox',
    checked: all,
    onchange: () => {
      for (const box of boxes) {
        box.input.disabled = allBox.checked
        if (allBox.checked) box.input.checked = true
      }
    },
  })
  const element = h(
    'div',
    { class: 'checks' },
    h(
      'label',
      { class: 'check' },
      allBox,
      allLabel ?? '全部邮箱（含以后新增）',
    ),
    boxes.map((box) => h('label', { class: 'check' }, box.input, box.address)),
  )
  const value = () =>
    allBox.checked
      ? ['*']
      : boxes.filter((box) => box.input.checked).map((box) => box.address)
  return { element, value }
}

/* ---------- overview ---------- */

async function overviewSection() {
  const [status, notifications] = await Promise.all([
    api('system.status'),
    api('notifications.status', { limit: 1 }),
  ])
  const inboxCount = state.inboxes.length
  return [
    h(
      'div',
      { class: 'card accent' },
      h('h3', {}, '服务状态'),
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, '版本'),
        h('dd', {}, `${status.version}（${status.environment}）`),
        h('dt', {}, '数据库'),
        h('dd', {}, badge(status.bindings.database, '正常', '异常')),
        h('dt', {}, '邮件存储'),
        h('dd', {}, badge(status.bindings.rawEmail, '正常', '缺失')),
        h('dt', {}, '发信'),
        h(
          'dd',
          {},
          status.sending?.mode === 'dry-run'
            ? h('span', { class: 'badge warn' }, '演练模式，不会真的发出')
            : badge(status.bindings.email, '已连接', '未连接'),
        ),
        h('dt', {}, '搜索'),
        h('dd', {}, badge(status.bindings.aiSearch, 'AI 搜索', '全文检索')),
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, '一览'),
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, '域名'),
        h(
          'dd',
          {},
          `${state.domains.length} 个`,
          ' ',
          h('a', { href: '#/settings/domains' }, '管理'),
        ),
        h('dt', {}, '邮箱地址'),
        h('dd', {}, `${inboxCount} 个`),
        h('dt', {}, 'Telegram'),
        h('dd', {}, badge(notifications.telegram.configured)),
        h('dt', {}, 'Webhook'),
        h('dd', {}, badge(notifications.webhook.configured)),
      ),
    ),
  ]
}

/* ---------- notifications ---------- */

function changed(before, after) {
  return (
    JSON.stringify([...before].sort()) !== JSON.stringify([...after].sort())
  )
}

async function notificationsSection() {
  const [settings, notifications] = await Promise.all([
    loadSettings(),
    api('notifications.status', { limit: 10 }),
  ])
  const testButton = (channel, label) =>
    h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        onclick: (event) =>
          withBusy(event.currentTarget, async () => {
            const result = await api('notifications.test', { channel })
            const parts = Object.entries(result.results).map(
              ([name, value]) =>
                `${name}：${value.state === 'delivered' ? '成功' : value.state}${value.error ? `（${value.error}）` : ''}`,
            )
            toast(parts.join('；'))
            route()
          }),
      },
      label,
    )

  const tgToken = settingInput(settings.TELEGRAM_BOT_TOKEN, {
    label: 'Bot 令牌',
    hint: '在 Telegram 里找 @BotFather 创建机器人后得到，形如 123456:ABC…',
  })
  const tgChat = settingInput(settings.TELEGRAM_CHAT_ID, {
    label: 'Chat ID',
    placeholder: '例如 123456789 或 @mychannel',
    hint: '先给机器人发一条消息，再用 @userinfobot 等查到你的 ID。',
  })
  const tgBoxes = mailboxChecks(notifications.telegram.mailboxes)
  const tgSave = h(
    'button',
    { class: 'btn primary', type: 'button' },
    '保存 Telegram 设置',
  )
  tgSave.addEventListener('click', () =>
    saveSettings(
      tgSave,
      { TELEGRAM_BOT_TOKEN: tgToken.read, TELEGRAM_CHAT_ID: tgChat.read },
      changed(notifications.telegram.mailboxes, tgBoxes.value())
        ? { TELEGRAM_NOTIFY_MAILBOXES: JSON.stringify(tgBoxes.value()) }
        : {},
    ),
  )

  const whUrl = settingInput(settings.WEBHOOK_URL, {
    label: '地址',
    type: 'url',
    placeholder: 'https://example.com/hooks/mailroom',
  })
  const whSecret = settingInput(settings.WEBHOOK_SECRET, {
    label: '签名密钥',
    hint: '至少 16 位。请求头 x-mailroom-signature 用它做 HMAC 签名。',
  })
  const events = notifications.webhook.events
  const eventBoxes = [
    ['message.received', '收到邮件'],
    ['message.sent', '发出邮件'],
  ].map(([key, label]) => ({
    key,
    input: h('input', { type: 'checkbox', checked: events.includes(key) }),
    label,
  }))
  const whBoxes = mailboxChecks(notifications.webhook.mailboxes)
  const whSave = h(
    'button',
    { class: 'btn primary', type: 'button' },
    '保存 Webhook 设置',
  )
  whSave.addEventListener('click', () => {
    const chosen = eventBoxes
      .filter((box) => box.input.checked)
      .map((box) => box.key)
    if (!chosen.length) {
      toast('至少选择一个事件', 'bad')
      return
    }
    const mailboxes = whBoxes.value()
    saveSettings(
      whSave,
      { WEBHOOK_URL: whUrl.read, WEBHOOK_SECRET: whSecret.read },
      {
        ...(changed(events, chosen)
          ? { WEBHOOK_EVENTS: chosen.join(',') }
          : {}),
        ...(changed(notifications.webhook.mailboxes, mailboxes)
          ? {
              WEBHOOK_NOTIFY_MAILBOXES: mailboxes.includes('*')
                ? null
                : JSON.stringify(mailboxes),
            }
          : {}),
      },
    )
  })

  return [
    h(
      'div',
      { class: 'card accent form' },
      h('h3', {}, 'Telegram', badge(notifications.telegram.configured)),
      h(
        'p',
        { class: 'hint' },
        '新邮件到达时发一条消息给你，包含发件人、主题和打开链接。',
      ),
      h('div', { class: 'field-row' }, tgToken.element, tgChat.element),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'label' }, '通知哪些邮箱'),
        tgBoxes.element,
      ),
      h(
        'div',
        { class: 'actions' },
        testButton('telegram', '发送测试消息'),
        h('span', { class: 'spacer' }),
        tgSave,
      ),
    ),
    h(
      'div',
      { class: 'card accent form' },
      h('h3', {}, 'Webhook', badge(notifications.webhook.configured)),
      h(
        'p',
        { class: 'hint' },
        '把邮件事件以签名的 JSON POST 到你的服务。失败时自动重试。',
      ),
      h('div', { class: 'field-row' }, whUrl.element, whSecret.element),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'label' }, '事件'),
        h(
          'div',
          { class: 'checks' },
          eventBoxes.map((box) =>
            h('label', { class: 'check' }, box.input, box.label),
          ),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'label' }, '哪些邮箱'),
        whBoxes.element,
      ),
      h(
        'div',
        { class: 'actions' },
        testButton('webhook', '发送测试请求'),
        h('span', { class: 'spacer' }),
        whSave,
      ),
    ),
    notifications.recent.length
      ? h(
          'div',
          { class: 'card' },
          h('h3', {}, '最近的投递'),
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'tbl' },
              h(
                'tr',
                {},
                h('th', {}, '时间'),
                h('th', {}, '渠道'),
                h('th', {}, '事件'),
                h('th', {}, '结果'),
              ),
              notifications.recent.map((item) =>
                h(
                  'tr',
                  {},
                  h('td', {}, shortDate(item.createdAt)),
                  h('td', {}, item.channel),
                  h('td', {}, item.event),
                  h(
                    'td',
                    {},
                    h(
                      'span',
                      {
                        class: `badge ${item.state === 'delivered' ? 'ok' : item.state === 'failed' ? 'bad' : ''}`,
                      },
                      { delivered: '成功', failed: '失败', skipped: '跳过' }[
                        item.state
                      ] ?? item.state,
                    ),
                    item.statusCode ? ` ${item.statusCode}` : '',
                    item.error ? ` · ${item.error}` : '',
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  ]
}

/* ---------- forwarding ---------- */

async function forwardingSection() {
  const settings = await loadSettings()
  const global = settingInput(settings.MAILROOM_FORWARD_TO, {
    label: '所有邮件都转发到',
    type: 'email',
    placeholder: '留空则不转发',
  })
  let byDomain = {}
  try {
    byDomain =
      JSON.parse(settings.MAILROOM_FORWARD_TO_BY_DOMAIN.value ?? '{}') ?? {}
  } catch {
    byDomain = {}
  }
  const domainInputs = state.domains.map((domain) => ({
    domain: domain.domain,
    input: h('input', {
      type: 'email',
      value: byDomain[domain.domain] ?? '',
      placeholder: '留空则用上面的地址',
    }),
  }))
  const save = h(
    'button',
    { class: 'btn primary', type: 'button' },
    '保存转发设置',
  )
  save.addEventListener('click', () => {
    const map = {}
    for (const { domain, input } of domainInputs) {
      if (input.value.trim()) map[domain] = input.value.trim().toLowerCase()
    }
    const before = JSON.stringify(byDomain)
    const after = JSON.stringify(map)
    saveSettings(
      save,
      { MAILROOM_FORWARD_TO: global.read },
      before === after
        ? {}
        : {
            MAILROOM_FORWARD_TO_BY_DOMAIN: Object.keys(map).length
              ? after
              : null,
          },
    )
  })
  return [
    h(
      'div',
      { class: 'card accent form' },
      h('h3', {}, '自动转发'),
      h(
        'p',
        { class: 'hint' },
        '邮件照常存进 Mailroom，同时原样（含附件）再转一份到下面的地址。按域名设置的地址优先。',
      ),
      global.element,
      domainInputs.length
        ? h(
            'div',
            { class: 'field' },
            h('span', { class: 'label' }, '按域名转发'),
            domainInputs.map(({ domain, input }) =>
              h(
                'div',
                { class: 'copy-row', style: 'align-items:center' },
                h('code', { style: 'min-width:140px' }, domain),
                input,
              ),
            ),
          )
        : null,
      h(
        'p',
        { class: 'hint' },
        '注意：转发地址必须先在 Cloudflare 控制台的 Email Routing → 目标地址 里添加并验证，否则 Cloudflare 会拒绝转发。',
      ),
      h('div', { class: 'actions' }, h('span', { class: 'spacer' }), save),
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, '手动转发'),
      h(
        'p',
        { class: 'hint' },
        '打开任意邮件，点「转发」或按 f。会生成一份带原文和附件的新草稿，确认后发出，收件人不限。',
      ),
    ),
  ]
}

/* ---------- account ---------- */

async function accountSection() {
  const settings = await loadSettings()
  const publicUrl = settingInput(settings.MAILROOM_PUBLIC_URL, {
    label: '后台网址',
    type: 'url',
    placeholder: location.origin,
    hint: '通知里的「打开邮件」链接用这个地址。留空则用 MCP 请求的地址。',
  })
  const save = h('button', { class: 'btn primary', type: 'button' }, '保存')
  save.addEventListener('click', () =>
    saveSettings(save, { MAILROOM_PUBLIC_URL: publicUrl.read }),
  )
  const theme = readPref('theme', 'auto')
  return [
    h(
      'div',
      { class: 'card accent' },
      h('h3', {}, '外观'),
      h(
        'div',
        { class: 'tabs', role: 'radiogroup', 'aria-label': '主题' },
        THEMES.map(([key, label]) =>
          h(
            'button',
            {
              class: `tab${theme === key ? ' active' : ''}`,
              type: 'button',
              role: 'radio',
              'aria-checked': theme === key ? 'true' : 'false',
              onclick: () => {
                setTheme(key)
                route()
              },
            },
            label,
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'card form' },
      h('h3', {}, '网址'),
      publicUrl.element,
      h('div', { class: 'actions' }, h('span', { class: 'spacer' }), save),
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, '登录'),
      h(
        'p',
        { class: 'hint', style: 'margin-bottom:12px' },
        '后台密码是 Worker 密钥 MAILROOM_WEB_PASSWORD，只能在 Cloudflare 里修改。改密码后所有登录和 OAuth 授权页都要重新输入。',
      ),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: async () => {
            await request('/v1/session', { method: 'DELETE' }).catch(
              () => undefined,
            )
            renderLogin('已退出登录')
          },
        },
        icon('logout'),
        '退出登录',
      ),
    ),
  ]
}

const SECTIONS = {
  overview: overviewSection,
  domains: domainsSection,
  notifications: notificationsSection,
  forwarding: forwardingSection,
  mcp: mcpSection,
  account: accountSection,
}

export async function settingsPane(tab = 'overview') {
  const key = SECTIONS[tab] ? tab : 'overview'
  if (key !== tab) go('settings')
  const content = await SECTIONS[key]()
  return h(
    'section',
    { class: 'read-pane' },
    h(
      'div',
      { class: 'read-inner' },
      h('div', { class: 'toolbar' }, menuButton(), h('strong', {}, '设置')),
      h(
        'h1',
        { class: 'thread-title' },
        SETTINGS_TABS.find(([id]) => id === key)?.[1],
      ),
      h(
        'nav',
        { class: 'settings-nav', 'aria-label': '设置分区' },
        SETTINGS_TABS.map(([id, label]) =>
          h(
            'a',
            { href: `#/settings/${id}`, class: id === key ? 'active' : '' },
            label,
          ),
        ),
      ),
      content,
    ),
  )
}
