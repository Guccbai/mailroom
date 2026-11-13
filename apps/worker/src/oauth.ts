import {
  getOAuthApi,
  OAuthProvider,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider'
import { toMailroomError } from '@mailroom/core'
import { handleMcpRequest, staticMcpTokenValid } from './mcp.js'
import {
  checkPassword,
  readCookie,
  SESSION_COOKIE,
  sameOriginRequest,
  verifySessionValue,
  webPasswordConfigured,
} from './web-auth.js'

export const MCP_PATH = '/mcp'
export const OAUTH_SCOPE = 'mailroom'

type DefaultHandler = ExportedHandler<Env> & {
  fetch: NonNullable<ExportedHandler<Env>['fetch']>
}

/** Canonical public origin: MAILROOM_PUBLIC_URL when set, else the request. */
export function publicOrigin(
  env: Pick<Env, 'MAILROOM_PUBLIC_URL'>,
  request: Request,
): string {
  if (env.MAILROOM_PUBLIC_URL?.trim()) {
    try {
      return new URL(env.MAILROOM_PUBLIC_URL.trim()).origin
    } catch {
      // Fall back to the request origin when the variable is malformed.
    }
  }
  return new URL(request.url).origin
}

export function oauthOptions(
  env: Env,
  request: Request,
  defaultHandler: DefaultHandler,
): OAuthProviderOptions<Env> {
  const resource = `${publicOrigin(env, request)}${MCP_PATH}`
  return {
    apiRoute: MCP_PATH,
    apiHandler: {
      fetch: (apiRequest, apiEnv, executionCtx) =>
        handleMcpRequest(apiRequest, apiEnv, executionCtx),
    },
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: [OAUTH_SCOPE],
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    resourceMetadata: { resource, resource_name: 'Mailroom' },
    resolveExternalToken: async ({ token, env: tokenEnv }) =>
      (await staticMcpTokenValid(tokenEnv, token))
        ? { props: { actor: 'mcp-token' }, audience: resource }
        : null,
  }
}

export function mcpFetch(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
  defaultHandler: DefaultHandler,
): Promise<Response> {
  return new OAuthProvider(oauthOptions(env, request, defaultHandler)).fetch(
    request,
    env,
    executionCtx,
  )
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
}

function page(
  title: string,
  body: string,
  status = 200,
  extra?: Headers,
): Response {
  const headers = new Headers(PAGE_HEADERS)
  extra?.forEach((value, key) => {
    // Our page policy already forbids framing and is stricter overall.
    if (key.toLowerCase() === 'set-cookie') headers.append(key, value)
    else if (!headers.has(key)) headers.set(key, value)
  })
  for (const cookie of extra?.getSetCookie?.() ?? []) {
    if (!headers.getSetCookie().includes(cookie))
      headers.append('set-cookie', cookie)
  }
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#1d1d1b;--muted:#6b6a66;--accent:#2f5d50;--border:#e3e1dc;--danger:#a33b2b}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#21211f;--text:#ecebe7;--muted:#a3a19b;--accent:#7fb7a4;--border:#34332f;--danger:#e48b7b}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:16px}
main{max-width:420px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:8px 0}.who{color:var(--text);font-weight:600}
.warn{color:var(--danger)}label{display:block;margin:16px 0 6px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font:inherit}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body><main>${body}</main></body></html>`,
    { status, headers },
  )
}

async function hasSession(env: Env, request: Request): Promise<boolean> {
  return verifySessionValue(
    env,
    readCookie(request.headers.get('cookie'), SESSION_COOKIE),
  )
}

export async function authorizePage(
  request: Request,
  env: Env,
  defaultHandler: DefaultHandler,
): Promise<Response> {
  const helpers = getOAuthApi(oauthOptions(env, request, defaultHandler), env)
  let authRequest: Awaited<ReturnType<typeof helpers.parseAuthRequest>>
  try {
    authRequest = await helpers.parseAuthRequest(request)
  } catch (error) {
    return page(
      '授权请求无效',
      `<h1>授权请求无效</h1><p>${escapeHtml(error instanceof Error ? error.message : 'Invalid request.')}</p>`,
      400,
    )
  }
  if (!webPasswordConfigured(env)) {
    return page(
      '未开启授权',
      '<h1>未开启授权</h1><p>请先在 Worker 中设置 MAILROOM_WEB_PASSWORD（至少 12 位），再连接 MCP 客户端。</p>',
      403,
    )
  }
  const consent = await helpers.describeConsent(authRequest)
  const transaction = await helpers.beginConsent(authRequest)
  const signedIn = await hasSession(env, request)
  const body = `<h1>允许连接你的邮箱？</h1>
<p><span class="who">${escapeHtml(consent.clientName || consent.clientId)}</span> 想通过 MCP 使用这个 Mailroom：读取邮件和附件、创建草稿、批准并发送邮件。</p>
<p>授权后会跳转到 <span class="who">${escapeHtml(consent.redirectHost)}</span>。</p>
${consent.redirectIsLoopback ? '<p class="warn">这个地址在本机上，任何本地程序都可能接收授权。只在你刚刚自己发起连接时同意。</p>' : ''}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(transaction.handle)}">
${signedIn ? '<p>你已登录网页后台。</p>' : '<label for="password">网页后台密码</label><input id="password" name="password" type="password" autocomplete="current-password" required>'}
<div class="row"><button name="action" value="deny" formnovalidate>拒绝</button><button class="primary" name="action" value="approve">允许</button></div>
</form>`
  return page('授权 Mailroom', body, 200, transaction.headers)
}

export async function authorizeSubmit(
  request: Request,
  env: Env,
  defaultHandler: DefaultHandler,
): Promise<Response> {
  if (!sameOriginRequest(request)) {
    return page(
      '请求被拒绝',
      '<h1>请求被拒绝</h1><p>跨站请求不被接受。</p>',
      403,
    )
  }
  const helpers = getOAuthApi(oauthOptions(env, request, defaultHandler), env)
  const form = await request.formData()
  const handle = String(form.get('handle') ?? '')
  try {
    if (form.get('action') !== 'approve') {
      const denied = await helpers.denyConsent(request, handle)
      return new Response(null, { status: 302, headers: denied.headers })
    }
    if (!(await hasSession(env, request))) {
      await checkPassword(env, request, String(form.get('password') ?? ''))
    }
    const approved = await helpers.approveConsent(request, handle, {
      scope: [OAUTH_SCOPE],
    })
    const client = await helpers.lookupClient(approved.request.clientId)
    const { redirectTo } = await helpers.completeAuthorization({
      request: approved.request,
      userId: 'owner',
      metadata: { clientName: client?.clientName ?? null },
      scope: [OAUTH_SCOPE],
      props: { actor: 'oauth', clientId: approved.request.clientId },
    })
    const headers = new Headers(approved.headers)
    headers.set('location', redirectTo)
    return new Response(null, { status: 302, headers })
  } catch (error) {
    const normalized = toMailroomError(error)
    const message =
      normalized.code === 'AUTH_REQUIRED'
        ? '密码不正确。请返回上一页重新输入。'
        : normalized.code === 'INTERNAL_ERROR' && error instanceof Error
          ? error.message
          : normalized.message
    return page(
      '授权失败',
      `<h1>授权失败</h1><p>${escapeHtml(message)}</p><p>请回到客户端重新发起连接。</p>`,
      normalized.code === 'RATE_LIMITED' ? 429 : 400,
    )
  }
}
