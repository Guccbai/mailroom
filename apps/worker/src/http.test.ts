import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createExecutionContext,
  createTestEnv,
  TEST_API_TOKEN,
  TEST_WEB_PASSWORD,
  type TestEnv,
} from '../test/sqlite-d1.mjs'
import worker from './index.js'

const ORIGIN = 'https://mail.example.com'

async function call(env: TestEnv, path: string, init: RequestInit = {}) {
  const executionCtx = createExecutionContext()
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, init),
    env,
    executionCtx,
  )
  await executionCtx.settle()
  return response
}

async function signIn(env: TestEnv): Promise<string> {
  const response = await call(env, '/v1/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ password: TEST_WEB_PASSWORD }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie') ?? ''
  return cookie.split(';')[0] ?? ''
}

function mcp(env: TestEnv, body: unknown, token?: string) {
  return call(env, '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('web app', () => {
  it('serves the app shell with a strict content security policy', async () => {
    const env = await createTestEnv()
    const response = await call(env, '/')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      '<script type="module" src="/app.js">',
    )
    const policy = response.headers.get('content-security-policy') ?? ''
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    const cached = await call(env, '/app.js', {
      headers: { 'if-none-match': response.headers.get('etag') ?? '' },
    })
    expect(cached.status).toBe(200)
  })

  it('signs in with the password and then authorizes same-origin operations', async () => {
    const env = await createTestEnv()
    const before = await call(env, '/v1/session')
    expect(await before.json()).toMatchObject({
      data: { authenticated: false, passwordConfigured: true },
    })
    const cookie = await signIn(env)
    const after = await call(env, '/v1/session', { headers: { cookie } })
    expect(await after.json()).toMatchObject({ data: { authenticated: true } })

    const list = await call(env, '/v1/operations/messages.list', {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ params: {} }),
    })
    expect(list.status).toBe(200)

    const crossSite = await call(env, '/v1/operations/messages.list', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://evil.example.org',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ params: {} }),
    })
    expect(crossSite.status).toBe(403)
  })

  it('rejects a wrong password without a cookie', async () => {
    const env = await createTestEnv()
    const response = await call(env, '/v1/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ password: 'nope' }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('keeps the bearer API working', async () => {
    const env = await createTestEnv()
    const response = await call(env, '/v1/operations/system.status', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    const payload = (await response.json()) as { data: Record<string, unknown> }
    expect(payload.data.sending).toEqual({ mode: 'live' })
    const denied = await call(env, '/v1/operations/system.status', {
      method: 'POST',
      body: '{}',
    })
    expect(denied.status).toBe(401)
  })
})

describe('attachment downloads', () => {
  it('serves signed links without a session and forces a download', async () => {
    const env = await createTestEnv()
    const meta = await call(env, '/v1/operations/attachments.get', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ params: { id: 'att_1' } }),
    })
    const { data } = (await meta.json()) as {
      data: { download: { path: string } }
    }
    const response = await call(env, data.download.path)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello')
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    )
    expect(response.headers.get('content-security-policy')).toContain('sandbox')

    const unsigned = await call(env, '/v1/attachments/att_1/download')
    expect(unsigned.status).toBe(401)
    const forged = await call(
      env,
      '/v1/attachments/att_1/download?expires=9999999999&signature=00',
    )
    expect(forged.status).toBe(401)
  })
})

describe('remote MCP', () => {
  it('requires a token and advertises OAuth metadata', async () => {
    const env = await createTestEnv()
    const response = await mcp(env, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata',
    )
    const metadata = await call(
      env,
      '/.well-known/oauth-protected-resource/mcp',
    )
    expect(await metadata.json()).toMatchObject({ resource: `${ORIGIN}/mcp` })
    const server = await call(env, '/.well-known/oauth-authorization-server')
    expect(await server.json()).toMatchObject({
      authorization_endpoint: `${ORIGIN}/authorize`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
    })
  })

  it('lists the three discovery tools and runs operations with a static token', async () => {
    const env = await createTestEnv({
      MAILROOM_MCP_TOKEN: 'mcp-token-0123456789abcdef0123',
    })
    const initialize = await mcp(
      env,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      },
      'mcp-token-0123456789abcdef0123',
    )
    expect(initialize.status).toBe(200)
    const tools = await mcp(
      env,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      'mcp-token-0123456789abcdef0123',
    )
    const listed = (await tools.json()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(listed.result.tools.map((tool) => tool.name).sort()).toEqual([
      'mailroom_describe_operation',
      'mailroom_list_operations',
      'mailroom_run_operation',
    ])
    const run = await mcp(
      env,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'mailroom_run_operation',
          arguments: { id: 'messages.list', params: { limit: 5 } },
        },
      },
      'mcp-token-0123456789abcdef0123',
    )
    const result = (await run.json()) as {
      result: { structuredContent: { data: { items: Array<{ id: string }> } } }
    }
    expect(result.result.structuredContent.data.items[0]?.id).toBe('msg_1')

    const apiToken = await mcp(
      env,
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      TEST_API_TOKEN,
    )
    expect(apiToken.status).toBe(401)
  })

  it('shows a consent page that asks for the password', async () => {
    const env = await createTestEnv()
    const registration = await call(env, '/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test Client',
        redirect_uris: ['https://client.example.org/callback'],
        token_endpoint_auth_method: 'none',
      }),
    })
    expect(registration.status).toBe(201)
    const client = (await registration.json()) as { client_id: string }
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://client.example.org/callback',
      scope: 'mailroom',
      state: 'xyz',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/mcp`,
    })
    const page = await call(env, `/authorize?${query}`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Test Client')
    expect(html).toContain('client.example.org')
    expect(html).toContain('type="password"')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
  })

  it('completes the OAuth flow with the password and serves MCP with the token', async () => {
    const env = await createTestEnv()
    const registration = await call(env, '/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Flow Client',
        redirect_uris: ['https://client.example.org/callback'],
        token_endpoint_auth_method: 'none',
      }),
    })
    const client = (await registration.json()) as { client_id: string }
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://client.example.org/callback',
      scope: 'mailroom',
      state: 'state-1',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/mcp`,
    })
    const page = await call(env, `/authorize?${query}`)
    const html = await page.text()
    const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? ''
    const cookies = page.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ')

    const wrong = await call(env, `/authorize?${query}`, {
      method: 'POST',
      headers: {
        cookie: cookies,
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        handle,
        action: 'approve',
        password: 'wrong',
      }),
    })
    expect(wrong.status).toBe(400)

    const approved = await call(env, `/authorize?${query}`, {
      method: 'POST',
      headers: {
        cookie: cookies,
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        handle,
        action: 'approve',
        password: TEST_WEB_PASSWORD,
      }),
    })
    expect(approved.status).toBe(302)
    const location = new URL(approved.headers.get('location') ?? '')
    expect(location.origin).toBe('https://client.example.org')
    expect(location.searchParams.get('state')).toBe('state-1')
    const code = location.searchParams.get('code') ?? ''

    const token = await call(env, '/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://client.example.org/callback',
        client_id: client.client_id,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      }),
    })
    expect(token.status).toBe(200)
    const { access_token: accessToken } = (await token.json()) as {
      access_token: string
    }
    const tools = await mcp(
      env,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      accessToken,
    )
    expect(tools.status).toBe(200)
  })
})
