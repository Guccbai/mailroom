import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createExecutionContext,
  createTestEnv,
  TEST_API_TOKEN,
  type TestEnv,
} from '../test/sqlite-d1.mjs'
import worker from './index.js'
import { executeOperation } from './operation-executor.js'
import { effectiveEnv } from './settings.js'

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

function operation(env: TestEnv, id: string, params: unknown, token: string) {
  return call(env, `/v1/operations/${id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ params }),
  })
}

async function data(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as {
    ok: boolean
    data?: Record<string, unknown>
    error?: { code: string }
  }
  return body.ok ? (body.data ?? {}) : { error: body.error?.code }
}

function run(env: TestEnv, id: string, params: Record<string, unknown>) {
  return executeOperation(
    { env, executionCtx: createExecutionContext(), requestId: 'req_test' },
    id,
    params,
  ) as Promise<Record<string, unknown>>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('stored settings', () => {
  it('override Worker values, hide secrets, and clear back to the default', async () => {
    const env = await createTestEnv({ WEBHOOK_EVENTS: 'message.sent' })
    const updated = await data(
      await operation(
        env,
        'settings.update',
        {
          values: {
            WEBHOOK_URL: 'https://hooks.example.org/mailroom',
            WEBHOOK_SECRET: 'signing value for tests',
            TELEGRAM_NOTIFY_MAILBOXES: '["Hello@Example.com"]',
          },
        },
        TEST_API_TOKEN,
      ),
    )
    const items = updated.items as Array<Record<string, unknown>>
    const byKey = Object.fromEntries(items.map((item) => [item.key, item]))
    expect(byKey.WEBHOOK_URL).toMatchObject({
      source: 'web',
      value: 'https://hooks.example.org/mailroom',
    })
    expect(byKey.WEBHOOK_SECRET).toEqual({
      key: 'WEBHOOK_SECRET',
      secret: true,
      source: 'web',
      configured: true,
    })
    expect(byKey.WEBHOOK_EVENTS).toMatchObject({
      source: 'worker',
      value: 'message.sent',
    })
    expect(byKey.TELEGRAM_NOTIFY_MAILBOXES?.value).toBe('["hello@example.com"]')

    const merged = await effectiveEnv(env as unknown as Env)
    expect(merged.WEBHOOK_URL).toBe('https://hooks.example.org/mailroom')
    expect(merged.WEBHOOK_EVENTS).toBe('message.sent')

    await run(env, 'settings.update', { values: { WEBHOOK_URL: null } })
    expect((await effectiveEnv(env as unknown as Env)).WEBHOOK_URL).toBe(
      env.WEBHOOK_URL,
    )
  })

  it('rejects unknown keys and bad values', async () => {
    const env = await createTestEnv()
    await expect(
      run(env, 'settings.update', { values: { MAILROOM_API_TOKEN: 'x' } }),
    ).rejects.toThrow(/cannot be changed/)
    await expect(
      run(env, 'settings.update', { values: { WEBHOOK_URL: 'http://x.test' } }),
    ).rejects.toThrow(/https/)
  })
})

describe('access tokens', () => {
  it('work for the API and MCP but cannot change settings or tokens', async () => {
    const env = await createTestEnv()
    const created = await data(
      await operation(env, 'tokens.create', { name: 'Laptop' }, TEST_API_TOKEN),
    )
    const token = String(created.token)
    expect(token).toMatch(/^mrt_/)

    const list = await data(
      await operation(env, 'messages.list', { limit: 5 }, token),
    )
    expect((list.items as unknown[]).length).toBe(1)

    const blocked = await data(
      await operation(
        env,
        'settings.update',
        { values: { WEBHOOK_EVENTS: 'message.sent' } },
        token,
      ),
    )
    expect(blocked.error).toBe('FORBIDDEN')

    const mcp = await call(env, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(mcp.status).toBe(200)

    const tokens = await data(
      await operation(env, 'tokens.list', {}, TEST_API_TOKEN),
    )
    const [row] = tokens.items as Array<Record<string, unknown>>
    expect(row).toMatchObject({ name: 'Laptop', revokedAt: null })
    expect(row?.lastUsedAt).not.toBeNull()
    expect(JSON.stringify(tokens)).not.toContain(token)

    await operation(env, 'tokens.revoke', { id: row?.id }, TEST_API_TOKEN)
    const after = await operation(env, 'messages.list', { limit: 5 }, token)
    expect(after.status).toBe(401)
  })
})

describe('forwarding and domain filters', () => {
  it('forwards a stored message with its attachment as a pending draft', async () => {
    const env = await createTestEnv({ MAILROOM_SEND_MODE: 'dry-run' })
    const draft = await run(env, 'drafts.forward', {
      messageId: 'msg_1',
      to: ['friend@example.org'],
      note: 'FYI',
    })
    expect(draft).toMatchObject({
      status: 'pending',
      subject: 'Fwd: Question',
      sender: 'hello@example.com',
      attachmentCount: 1,
    })
    const stored = await run(env, 'drafts.get', {
      id: draft.id,
      includeContent: true,
    })
    expect(JSON.stringify(stored)).toContain('Forwarded message')
    expect(JSON.stringify(stored)).toContain('reader@example.net')

    const bare = await run(env, 'drafts.forward', {
      messageId: 'msg_1',
      to: ['friend@example.org'],
      includeAttachments: false,
    })
    expect(bare.attachmentCount).toBe(0)
  })

  it('lists messages and inboxes by domain', async () => {
    const env = await createTestEnv()
    const hit = await run(env, 'messages.list', { domainId: 'dom_1', limit: 5 })
    expect((hit.items as unknown[]).length).toBe(1)
    const miss = await run(env, 'messages.list', {
      domainId: 'dom_2',
      limit: 5,
    })
    expect((miss.items as unknown[]).length).toBe(0)
    const inboxes = await run(env, 'inboxes.list', { limit: 5 })
    expect((inboxes.items as Array<Record<string, unknown>>)[0]?.domainId).toBe(
      'dom_1',
    )
  })
})
