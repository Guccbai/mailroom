// Part of the Mailroom web app. See app.js. Settings: connecting AI clients
// over MCP, OAuth first, with optional access tokens.

import { route } from './app.js'
import {
  api,
  confirmDialog,
  copyBlock,
  h,
  promptDialog,
  shortDate,
  withBusy,
} from './lib.js'

function showToken(created) {
  const dialog = h(
    'dialog',
    {},
    h('h3', {}, `令牌「${created.name}」已创建`),
    h(
      'p',
      { class: 'hint' },
      '只显示这一次。请现在复制并保存到客户端的配置里。',
    ),
    copyBlock(created.token),
    h(
      'div',
      { class: 'actions', style: 'margin-top:16px' },
      h('span', { class: 'spacer' }),
      h(
        'button',
        { class: 'btn primary', onclick: () => dialog.close() },
        '我已保存',
      ),
    ),
  )
  dialog.addEventListener('close', () => {
    dialog.remove()
    route()
  })
  document.body.append(dialog)
  dialog.showModal()
}

function tokensCard(tokens) {
  const create = h('button', { class: 'btn', type: 'button' }, '创建令牌')
  create.addEventListener('click', async () => {
    const name = await promptDialog(
      '创建访问令牌',
      '名称，例如 Cursor 或 备份脚本',
    )
    if (!name) return
    await withBusy(create, async () => {
      showToken(await api('tokens.create', { name: name.slice(0, 80) }))
    })
  })
  const active = tokens.filter((token) => !token.revokedAt)
  return h(
    'div',
    { class: 'card' },
    h('h3', {}, '访问令牌（可选）'),
    h(
      'p',
      { class: 'hint' },
      '只给不支持 OAuth 的客户端或脚本用，可随时吊销。令牌能读邮件、起草、批准和发送，但不能改设置或管理令牌。',
    ),
    active.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'tbl' },
            h(
              'tr',
              {},
              h('th', {}, '名称'),
              h('th', {}, '开头'),
              h('th', {}, '创建'),
              h('th', {}, '最近使用'),
              h('th', {}),
            ),
            active.map((token) =>
              h(
                'tr',
                {},
                h('td', {}, token.name),
                h('td', {}, h('code', {}, `${token.prefix}…`)),
                h('td', {}, shortDate(token.createdAt)),
                h(
                  'td',
                  {},
                  token.lastUsedAt ? shortDate(token.lastUsedAt) : '从未',
                ),
                h(
                  'td',
                  { class: 'actions-cell' },
                  h(
                    'button',
                    {
                      class: 'btn small danger',
                      type: 'button',
                      onclick: async (event) => {
                        const button = event.currentTarget
                        if (
                          !(await confirmDialog(
                            `吊销「${token.name}」？`,
                            ['用这个令牌的客户端会立刻失去访问权限。'],
                            '吊销',
                          ))
                        )
                          return
                        await withBusy(button, async () => {
                          await api('tokens.revoke', { id: token.id })
                          route()
                        })
                      },
                    },
                    '吊销',
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'hint', style: 'margin-bottom:12px' }, '还没有令牌。'),
    h('div', { class: 'actions', style: 'margin-top:12px' }, create),
  )
}

export async function mcpSection() {
  const tokens = await api('tokens.list')
  const url = `${location.origin}/mcp`
  return [
    h(
      'div',
      { class: 'card accent' },
      h('h3', {}, '连接地址'),
      h(
        'p',
        { class: 'hint' },
        '让 AI 客户端读取、起草、批准和发送邮件。默认用 OAuth 授权：客户端会打开授权页，输入网页后台密码即可，不需要复制任何密钥。',
      ),
      copyBlock(url),
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, 'Claude Code'),
      h('ol', { class: 'steps' }, h('li', {}, '在终端运行：')),
      copyBlock(`claude mcp add --transport http mailroom ${url}`),
      h(
        'ol',
        { class: 'steps', start: 2, style: 'margin-top:10px' },
        h(
          'li',
          {},
          '打开 Claude Code，输入 /mcp，选中 mailroom，选「Authenticate」。',
        ),
        h('li', {}, '浏览器会打开 Mailroom 授权页，输入后台密码并同意。'),
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, 'Claude 网页版和桌面版'),
      h(
        'ol',
        { class: 'steps' },
        h('li', {}, '设置 → 连接器（Connectors）→ 添加自定义连接器。'),
        h('li', {}, '名称填 Mailroom，地址填上面的连接地址。'),
        h('li', {}, '点「连接」，在授权页输入后台密码。'),
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, '其他客户端'),
      h(
        'p',
        { class: 'hint' },
        '支持远程 MCP 和 OAuth 的客户端（如 Cursor、VS Code、ChatGPT 连接器）直接填连接地址即可。不支持 OAuth 的，创建一个访问令牌，并在请求头里带上：',
      ),
      copyBlock('Authorization: Bearer mrt_…'),
    ),
    tokensCard(tokens.items),
  ]
}
