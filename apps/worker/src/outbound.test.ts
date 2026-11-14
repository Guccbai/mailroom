import { afterEach, describe, expect, it, vi } from 'vitest'
import { emailBuilder, sendOutbound } from './outbound.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('emailBuilder', () => {
  it('passes several recipients, Cc, and decoded attachments', () => {
    const builder = emailBuilder({
      from: 'hello@example.com',
      to: ['a@example.org', 'b@example.org'],
      cc: ['c@example.org'],
      subject: 'Files',
      text: 'Attached',
      attachments: [
        {
          filename: 'a.txt',
          contentType: 'text/plain',
          contentBase64: btoa('abc'),
        },
      ],
    }) as EmailMessageBuilder & { cc?: string[] }
    expect(builder.to).toEqual(['a@example.org', 'b@example.org'])
    expect(builder.cc).toEqual(['c@example.org'])
    expect(builder.attachments?.[0]).toMatchObject({
      disposition: 'attachment',
      filename: 'a.txt',
      type: 'text/plain',
    })
    expect(
      new TextDecoder().decode(builder.attachments?.[0]?.content as Uint8Array),
    ).toBe('abc')
  })

  it('omits empty optional fields', () => {
    const builder = emailBuilder({
      from: 'hello@example.com',
      to: 'a@example.org',
      subject: 'Hi',
      text: 'Hello',
      cc: [],
      attachments: [],
    })
    expect(Object.keys(builder).sort()).toEqual([
      'from',
      'subject',
      'text',
      'to',
    ])
  })
})

describe('dry-run sending', () => {
  it('never calls Email Service or a relay', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const send = vi.fn()
    const fetch = vi.spyOn(globalThis, 'fetch')
    const result = await sendOutbound(
      { MAILROOM_SEND_MODE: 'dry-run', EMAIL: { send } } as unknown as Env,
      {
        from: 'hello@example.com',
        to: 'a@example.org',
        subject: 'Hi',
        text: 'Hello',
      },
      'https://relay.example.org',
      'key-0123456789abcdef',
    )
    expect(result.messageId).toMatch(/^<dry-run\..+@mailroom\.invalid>$/)
    expect(send).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
