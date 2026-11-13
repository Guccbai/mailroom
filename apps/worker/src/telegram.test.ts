import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  notifyTelegram,
  telegramMailboxEnabled,
  telegramText,
} from './telegram.js'

describe('Telegram notification mailbox selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is disabled when no mailbox allowlist is configured', () => {
    expect(telegramMailboxEnabled('alerts@example.com', undefined)).toBe(false)
    expect(telegramMailboxEnabled('alerts@example.com', '')).toBe(false)
    expect(telegramMailboxEnabled('alerts@example.com', '[]')).toBe(false)
  })

  it('matches exact mailbox addresses without case sensitivity', () => {
    const configured = JSON.stringify([
      'Support@example.com',
      'alerts@example.net',
    ])

    expect(telegramMailboxEnabled('support@EXAMPLE.com', configured)).toBe(true)
    expect(telegramMailboxEnabled('sales@example.com', configured)).toBe(false)
  })

  it('fails closed for invalid configuration', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(
      telegramMailboxEnabled('alerts@example.com', '{"alerts":true}'),
    ).toBe(false)
    expect(error).toHaveBeenCalledWith('mailroom_telegram_config_invalid', {
      error: 'expected a JSON array of mailbox addresses',
    })
  })

  it('does not call Telegram for a mailbox outside the allowlist', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await notifyTelegram(
      {
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: 'chat-id',
        TELEGRAM_NOTIFY_MAILBOXES: '["alerts@example.com"]',
      } as Env,
      {
        id: 'msg_test',
        from: 'sender@example.net',
        to: 'support@example.com',
        subject: 'Test',
        preview: 'Hello',
      },
    )

    expect(fetch).not.toHaveBeenCalled()
  })

  it('calls Telegram for a mailbox in the allowlist', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetch)

    await notifyTelegram(
      {
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: 'chat-id',
        TELEGRAM_NOTIFY_MAILBOXES: '["alerts@example.com"]',
      } as Env,
      {
        id: 'msg_test',
        from: 'sender@example.net',
        to: 'alerts@example.com',
        subject: 'Test',
        preview: 'Hello',
      },
    )

    expect(fetch).toHaveBeenCalledOnce()
  })

  it('accepts "*" for every mailbox', () => {
    expect(telegramMailboxEnabled('any@example.com', '["*"]')).toBe(true)
  })

  it('reports a failed Telegram request without throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('bad chat', { status: 400 })),
    )
    const result = await notifyTelegram(
      {
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: 'chat-id',
        TELEGRAM_NOTIFY_MAILBOXES: '["*"]',
      } as Env,
      {
        id: 'msg_test',
        from: 'sender@example.net',
        to: 'alerts@example.com',
        subject: 'Test',
        preview: 'Hello',
      },
    )
    expect(result).toMatchObject({ state: 'failed', statusCode: 400 })
  })
})

describe('Telegram message text', () => {
  it('lists attachments and links to the web app', () => {
    const text = telegramText({
      id: 'msg_1',
      from: 'a@example.net',
      to: 'hello@example.com',
      subject: '',
      preview: 'Body',
      attachments: [{ filename: 'a.pdf' }, { filename: null }],
      link: 'https://mail.example.com/#/message/msg_1',
    })
    expect(text).toContain('Subject: (no subject)')
    expect(text).toContain('Attachments: a.pdf, unnamed file')
    expect(text).toContain('Open: https://mail.example.com/#/message/msg_1')
  })
})
