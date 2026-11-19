import { sha256Hex, signRelayRequest } from '@mailroom/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index.js'
import { RESEND_API_URL, resendPayload, sendWithResend } from './resend.js'

const message = {
  from: 'hello@ontara.co',
  to: ['a@example.org', 'b@example.org'],
  cc: ['c@example.org'],
  replyTo: 'support@ontara.co',
  subject: 'Re: Files',
  text: 'Attached',
  html: '<p>Attached</p>',
  inReplyTo: '<parent@example.org>',
  references: ['<root@example.org>', '<parent@example.org>'],
  attachments: [
    {
      filename: 'a.txt',
      contentType: 'text/plain',
      contentBase64: btoa('abc'),
    },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Resend payload', () => {
  it('maps recipients, threading headers, and attachments', () => {
    expect(resendPayload(message, '<id@ontara.co>')).toEqual({
      from: 'hello@ontara.co',
      to: ['a@example.org', 'b@example.org'],
      cc: ['c@example.org'],
      reply_to: ['support@ontara.co'],
      subject: 'Re: Files',
      text: 'Attached',
      html: '<p>Attached</p>',
      headers: {
        'Message-ID': '<id@ontara.co>',
        'In-Reply-To': '<parent@example.org>',
        References: '<root@example.org> <parent@example.org>',
      },
      attachments: [
        { filename: 'a.txt', content: btoa('abc'), content_type: 'text/plain' },
      ],
    })
  })

  it('wraps a single recipient and leaves out empty fields', () => {
    const payload = resendPayload(
      { from: 'a@ontara.co', to: 'b@example.org', subject: 'Hi', text: 'Hi' },
      '<id@ontara.co>',
    )
    expect(payload.to).toEqual(['b@example.org'])
    expect(payload).not.toHaveProperty('cc')
    expect(payload).not.toHaveProperty('attachments')
    expect(payload).not.toHaveProperty('reply_to')
  })
})

describe('sendWithResend', () => {
  it('sends with the key and idempotency key, returning a sender-domain Message-ID', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ id: 'resend-id' }, { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    const result = await sendWithResend('re_test', message, 'draft-1')

    expect(result.providerId).toBe('resend-id')
    expect(result.messageId).toMatch(/^<[0-9a-f-]{36}@ontara\.co>$/)
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(RESEND_API_URL)
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer re_test')
    expect(headers['idempotency-key']).toBe('draft-1')
    const body = JSON.parse(String(init.body))
    expect(body.headers['Message-ID']).toBe(result.messageId)
  })

  it('throws with Resend’s message when the send is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { name: 'validation_error', message: 'Domain not verified' },
            { status: 403 },
          ),
        ),
    )
    await expect(sendWithResend('re_test', message, 'k')).rejects.toThrow(
      'Resend rejected the email (403): Domain not verified',
    )
  })
})

async function signedSend(body: string) {
  const path = '/v1/send'
  const signed = {
    timestamp: String(Date.now()),
    idempotencyKey: 'attempt-1',
    method: 'POST',
    path,
    bodySha256: await sha256Hex(body),
  }
  const request = new Request(`https://relay.example.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mailroom-timestamp': signed.timestamp,
      'x-mailroom-idempotency-key': signed.idempotencyKey,
      'x-mailroom-body-sha256': signed.bodySha256,
      'x-mailroom-signature': await signRelayRequest('test-secret', signed),
    },
    body,
  })
  return request as Parameters<typeof worker.fetch>[0]
}

describe('relay /v1/send', () => {
  const body = JSON.stringify({
    from: 'hello@ontara.co',
    to: 'b@example.org',
    subject: 'Hi',
    text: 'Hello',
  })

  it('sends through Resend when RESEND_API_KEY is set', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'resend-id' }))
    vi.stubGlobal('fetch', fetch)
    const emailSend = vi.fn()

    const response = await worker.fetch(await signedSend(body), {
      INGRESS_SECRET: 'test-secret',
      ALLOWED_FROM_DOMAINS: 'ontara.co',
      RESEND_API_KEY: 're_test',
      EMAIL: { send: emailSend },
    } as never)

    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      ok: boolean
      messageId: string
    }
    expect(payload.ok).toBe(true)
    expect(payload.messageId).toMatch(/@ontara\.co>$/)
    expect(emailSend).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps using Email Service without RESEND_API_KEY', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const emailSend = vi.fn().mockResolvedValue({ messageId: '<cf@ontara.co>' })

    const response = await worker.fetch(await signedSend(body), {
      INGRESS_SECRET: 'test-secret',
      ALLOWED_FROM_DOMAINS: 'ontara.co',
      EMAIL: { send: emailSend },
    } as never)

    expect(await response.json()).toEqual({
      ok: true,
      messageId: '<cf@ontara.co>',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a Resend rejection as a failed send', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ message: 'Invalid from' }, { status: 422 }),
        ),
    )
    const response = await worker.fetch(await signedSend(body), {
      INGRESS_SECRET: 'test-secret',
      ALLOWED_FROM_DOMAINS: 'ontara.co',
      RESEND_API_KEY: 're_test',
      EMAIL: { send: vi.fn() },
    } as never)
    expect(response.status).toBe(400)
    const payload = (await response.json()) as {
      ok: boolean
      error: { message: string }
    }
    expect(payload.ok).toBe(false)
    expect(payload.error.message).toContain('Invalid from')
  })
})
