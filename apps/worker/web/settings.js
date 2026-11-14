// Part of the Mailroom web app. See app.js.

import { loadInboxes, route } from './app.js'
import { menuButton, renderLogin } from './layout.js'
import { api, h, request, shortDate, state, toast, withBusy } from './lib.js'

/* ---------- settings ---------- */

export function badge(ok, yes = '已配置', no = '未配置') {
  return h('span', { class: `badge ${ok ? 'ok' : 'warn'}` }, ok ? yes : no)
}

export async function settingsPane() {
  const [status, notifications, domains] = await Promise.all([
    api('system.status'),
    api('notifications.status', { limit: 10 }),
    api('domains.list', { limit: 50 }),
  ])
  if (!state.inboxes.length) await loadInboxes()
  const origin = location.origin
  const testButton = (channel, label) =>
    h(
      'button',
      {
        class: 'btn small',
        onclick: (event) =>
          withBusy(event.currentTarget, async () => {
            const result = await api('notifications.test', { channel })
            const parts = Object.entries(result.results).map(
              ([name, value]) =>
                `${name}: ${value.state}${value.error ? `（${value.error}）` : ''}`,
            )
            toast(parts.join('；'))
            route()
          }),
      },
      label,
    )
  return h(
    'section',
    { class: 'read-pane' },
    h(
      'div',
      { class: 'read-inner' },
      h('div', { class: 'toolbar' }, menuButton()),
      h('h1', { class: 'thread-title' }, '设置'),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, '服务状态'),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, '版本'),
          h('dd', {}, `${status.version}（${status.environment}）`),
          h('dt', {}, '数据库'),
          h('dd', {}, badge(status.bindings.database, '正常', '异常')),
          h('dt', {}, '邮件存储 R2'),
          h('dd', {}, badge(status.bindings.rawEmail, '正常', '缺失')),
          h('dt', {}, '发信'),
          h(
            'dd',
            {},
            status.sending?.mode === 'dry-run'
              ? h('span', { class: 'badge warn' }, '演练模式，不会真的发出')
              : badge(status.bindings.email, '已连接', '未连接'),
          ),
          h('dt', {}, 'AI 搜索'),
          h(
            'dd',
            {},
            badge(status.bindings.aiSearch, '已连接', '未连接，使用全文检索'),
          ),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, '邮箱地址'),
        state.inboxes.length
          ? h(
              'table',
              { class: 'tbl' },
              h(
                'tr',
                {},
                h('th', {}, '地址'),
                h('th', {}, '名称'),
                h('th', {}, '状态'),
              ),
              state.inboxes.map((inbox) =>
                h(
                  'tr',
                  {},
                  h('td', {}, inbox.address),
                  h('td', {}, inbox.name ?? ''),
                  h('td', {}, badge(inbox.enabled, '启用', '停用')),
                ),
              ),
            )
          : h(
              'p',
              { class: 'hint' },
              '还没有邮箱。用 mailroom CLI 或 MCP 运行 domains.upsert、inboxes.upsert 和 routes.upsert 添加。',
            ),
        domains.items.length
          ? h(
              'p',
              { class: 'hint' },
              `域名：${domains.items.map((item) => item.domain).join('、')}`,
            )
          : null,
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, '新邮件通知'),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, 'Telegram'),
          h(
            'dd',
            {},
            badge(notifications.telegram.configured),
            ' ',
            notifications.telegram.mailboxes.length
              ? `通知：${notifications.telegram.mailboxes.join(', ')}`
              : '未选择邮箱（TELEGRAM_NOTIFY_MAILBOXES）',
          ),
          h('dt', {}, 'Webhook'),
          h(
            'dd',
            {},
            badge(notifications.webhook.configured),
            ' ',
            notifications.webhook.host
              ? `${notifications.webhook.host} · ${notifications.webhook.events.join(', ')}`
              : notifications.webhook.invalidUrl
                ? 'WEBHOOK_URL 必须是 https 地址'
                : '',
          ),
        ),
        h(
          'div',
          { class: 'actions', style: 'margin-top:12px' },
          testButton('telegram', '测试 Telegram'),
          testButton('webhook', '测试 Webhook'),
        ),
        notifications.recent.length
          ? h(
              'table',
              { class: 'tbl', style: 'margin-top:12px' },
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
                    item.state,
                    item.statusCode ? ` · ${item.statusCode}` : '',
                    item.error ? ` · ${item.error}` : '',
                  ),
                ),
              ),
            )
          : null,
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'MCP 连接'),
        h(
          'p',
          { class: 'hint' },
          '让 AI 客户端读取、起草、批准和发送邮件。支持 OAuth（Claude 网页版等，授权时输入网页后台密码）和 Bearer 令牌（Claude Code 等）。',
        ),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, '地址'),
          h('dd', {}, h('code', {}, `${origin}/mcp`)),
        ),
        h(
          'pre',
          { class: 'code' },
          `claude mcp add --transport http mailroom ${origin}/mcp \\\n  --header "Authorization: Bearer <MAILROOM_MCP_TOKEN>"`,
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, '账号'),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              await request('/v1/session', { method: 'DELETE' }).catch(
                () => undefined,
              )
              renderLogin('已退出登录')
            },
          },
          '退出登录',
        ),
      ),
    ),
  )
}
