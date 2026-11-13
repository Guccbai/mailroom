import { afterEach, describe, expect, it, vi } from 'vitest'
import { hmacHex } from './signing.js'
import {
  deliverWebhook,
  type WebhookEvent,
  webhookEvents,
  webhookMailboxEnabled,
  webhookSignature,
} from './webhook.js'

const event: WebhookEvent = {
  id: 'evt_1',
  type: 'message.received',
  createdAt: '2026-11-01T00:00:00.000Z',
  data: { message: { id: 'msg_1' } },
}
const env = {
  WEBHOOK_URL: 'https://hooks.example.org/mail',
  WEBHOOK_SECRET: 'webhook-secret-0123456789',
} as Env
const noSleep = { sleep: async () => undefined }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('webhook signatures', () => {
  it('signs the timestamp and exact body so receivers can verify', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const result = await deliverWebhook(env, event, noSleep)
    expect(result).toMatchObject({
      state: 'delivered',
      attempts: 1,
      statusCode: 204,
    })
    const init = fetch.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    const timestamp = headers['x-mailroom-timestamp'] ?? ''
    expect(headers['x-mailroom-event']).toBe('message.received')
    expect(headers['x-mailroom-delivery']).toBe('evt_1')
    expect(headers['x-mailroom-signature']).toBe(
      `v1=${await hmacHex(String(env.WEBHOOK_SECRET), `${timestamp}.${String(init.body)}`)}`,
    )
    expect(init.redirect).toBe('manual')
  })

  it('produces a stable v1 signature', async () => {
    expect(await webhookSignature('secret', '1700000000', '{}')).toMatch(
      /^v1=[a-f0-9]{64}$/,
    )
  })
})

describe('webhook delivery', () => {
  it('retries server errors and rate limits, then succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const result = await deliverWebhook(env, event, noSleep)
    expect(result).toMatchObject({ state: 'delivered', attempts: 3 })
  })

  it('does not retry a client error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetch = vi.fn().mockResolvedValue(new Response('no', { status: 400 }))
    vi.stubGlobal('fetch', fetch)
    const result = await deliverWebhook(env, event, noSleep)
    expect(fetch).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ state: 'failed', statusCode: 400 })
  })

  it('reports network failures after three attempts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('connection reset')),
    )
    const result = await deliverWebhook(env, event, noSleep)
    expect(result).toMatchObject({
      state: 'failed',
      attempts: 3,
      error: 'connection reset',
    })
  })

  it('skips plain http URLs and short secrets', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(
      await deliverWebhook(
        { ...env, WEBHOOK_URL: 'http://hooks.example.org' },
        event,
      ),
    ).toMatchObject({ state: 'skipped' })
    expect(
      await deliverWebhook({ ...env, WEBHOOK_SECRET: 'short' }, event),
    ).toMatchObject({ state: 'skipped' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('webhook filters', () => {
  it('defaults to new inbound mail and ignores unknown events', () => {
    expect(webhookEvents({} as Env)).toEqual(['message.received'])
    expect(
      webhookEvents({ WEBHOOK_EVENTS: 'message.sent, bogus' } as Env),
    ).toEqual(['message.sent'])
  })

  it('sends for every mailbox unless a list is configured', () => {
    expect(webhookMailboxEnabled({} as Env, 'a@example.com')).toBe(true)
    const listed = { WEBHOOK_NOTIFY_MAILBOXES: '["A@example.com"]' } as Env
    expect(webhookMailboxEnabled(listed, 'a@example.com')).toBe(true)
    expect(webhookMailboxEnabled(listed, 'b@example.com')).toBe(false)
  })
})
