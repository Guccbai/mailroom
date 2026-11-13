import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyMigration,
  createExecutionContext,
  createTestDb,
  createTestEnv,
  migrationFiles,
  type TestEnv,
} from '../test/sqlite-d1.mjs'
import { verifyDownloadSignature } from './attachments.js'
import { executeOperation } from './operation-executor.js'

const base64 = (text: string) => btoa(text)

async function run(
  env: TestEnv,
  id: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const executionCtx = createExecutionContext()
  const result = (await executeOperation(
    { env, executionCtx, requestId: 'req_test' },
    id,
    params,
  )) as Record<string, unknown>
  await executionCtx.settle()
  return result
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('migration 0003', () => {
  it('keeps existing reply drafts and their recipients', () => {
    const [first, second, third] = migrationFiles()
    expect(third).toBe('0003_drafts_compose_notifications.sql')
    const db = createTestDb({ migrations: [String(first), String(second)] })
    const now = '2026-11-01T10:00:00.000Z'
    db.sqlite.exec(`
      INSERT INTO domains VALUES ('dom_1', 'example.com', NULL, NULL, NULL, 1, '${now}', '${now}');
      INSERT INTO inboxes VALUES ('inb_1', 'dom_1', 'hello', 'Hello', 1, '${now}', '${now}');
      INSERT INTO threads VALUES ('thr_1', 'inb_1', 'q', '${now}', 1, '${now}', '${now}');
      INSERT INTO messages (id, thread_id, inbox_id, direction, status, sender, recipients,
        subject, normalized_subject, preview, size_bytes, received_at, created_at)
        VALUES ('msg_1', 'thr_1', 'inb_1', 'inbound', 'read', 'a@example.net',
        '["hello@example.com"]', 'Q', 'q', 'p', 1, '${now}', '${now}');
      INSERT INTO drafts (id, message_id, thread_id, status, recipient, sender, subject,
        text_body, validation, source, created_at, updated_at)
        VALUES ('drf_1', 'msg_1', 'thr_1', 'approved', 'a@example.net', 'hello@example.com',
        'Re: Q', 'Answer', '{}', 'manual', '${now}', '${now}');
      INSERT INTO draft_events VALUES ('evt_1', 'drf_1', 'created', 'manual', NULL, '${now}');
    `)
    applyMigration(db.sqlite, String(third))
    const rows = db.sqlite
      .prepare(
        'SELECT kind, inbox_id, to_addresses, cc_addresses, status FROM drafts',
      )
      .all()
    expect(rows).toEqual([
      {
        kind: 'reply',
        inbox_id: 'inb_1',
        to_addresses: '["a@example.net"]',
        cc_addresses: '[]',
        status: 'approved',
      },
    ])
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM draft_events').all(),
    ).toEqual([{ n: 1 }])
  })
})

describe('composing and sending a new email', () => {
  it('stores attachments, requires approval, and records the sent message', async () => {
    const env = await createTestEnv({ MAILROOM_SEND_MODE: 'dry-run' })
    const draft = await run(env, 'drafts.compose', {
      from: 'Hello@Example.com',
      to: ['ann@example.org', 'bo@example.org'],
      cc: ['cy@example.org'],
      subject: 'Plans',
      text: 'See the attached plan.',
      attachments: [
        {
          filename: 'plan.txt',
          contentType: 'text/plain',
          contentBase64: base64('plan v1'),
        },
      ],
    })
    expect(draft).toMatchObject({
      kind: 'new',
      status: 'pending',
      sender: 'hello@example.com',
      to: ['ann@example.org', 'bo@example.org'],
      attachmentCount: 1,
    })
    expect(
      [...env.RAW.objects.keys()].some((key) =>
        key.startsWith(`drafts/${draft.id}/`),
      ),
    ).toBe(true)

    await expect(
      run(env, 'drafts.send', {
        id: draft.id,
        idempotencyKey: 'send-0123456789abcdef',
      }),
    ).rejects.toThrow(/approved draft/)

    await run(env, 'drafts.approve', { id: draft.id, approvedBy: 'owner' })
    const sent = await run(env, 'drafts.send', {
      id: draft.id,
      idempotencyKey: 'send-0123456789abcdef',
    })
    expect(sent.status).toBe('sent')
    expect(String(sent.providerMessageId)).toMatch(/dry-run/)
    expect(env.sent).toHaveLength(0)

    const thread = await run(env, 'messages.thread', {
      threadId: sent.threadId,
      includeBodies: true,
    })
    const [message] = thread.messages as Array<Record<string, unknown>>
    expect(message).toMatchObject({
      direction: 'outbound',
      to: ['ann@example.org', 'bo@example.org'],
      cc: ['cy@example.org'],
      subject: 'Plans',
    })
    const attachments = message?.attachments as Array<Record<string, unknown>>
    expect(attachments).toHaveLength(1)
    const download = await run(env, 'attachments.get', {
      id: attachments[0]?.id,
      includeContent: true,
    })
    expect(download.contentBase64).toBe(base64('plan v1'))

    const replay = await run(env, 'drafts.send', {
      id: draft.id,
      idempotencyKey: 'send-0123456789abcdef',
    })
    expect(replay).toMatchObject({ idempotentReplay: true, state: 'sent' })
  })

  it('rejects a From address that no inbox owns', async () => {
    const env = await createTestEnv()
    await expect(
      run(env, 'drafts.compose', {
        from: 'other@example.com',
        to: ['ann@example.org'],
        subject: 'Hi',
        text: 'Hello',
      }),
    ).rejects.toThrow(/No configured inbox/)
  })

  it('validates attachment names and base64 before storing anything', async () => {
    const env = await createTestEnv()
    for (const attachment of [
      { filename: '../etc/passwd', contentBase64: base64('x') },
      { filename: 'a.txt', contentBase64: 'not base64!' },
    ]) {
      await expect(
        run(env, 'drafts.compose', {
          inboxId: 'inb_1',
          to: ['ann@example.org'],
          subject: 'Hi',
          text: 'Hello',
          attachments: [attachment],
        }),
      ).rejects.toThrow(/Invalid operation parameters/)
    }
    expect(env.RAW.objects.size).toBe(1)
  })
})

describe('replying with Cc and attachments', () => {
  it('sends threading headers, Cc, and attachment bytes to Email Service', async () => {
    const env = await createTestEnv()
    const draft = await run(env, 'drafts.create', {
      messageId: 'msg_1',
      text: 'Thanks!',
      cc: ['team@example.com'],
      attachments: [
        {
          filename: 'reply.txt',
          contentType: 'text/plain',
          contentBase64: base64('reply'),
        },
      ],
    })
    await run(env, 'drafts.approve', { id: draft.id, approvedBy: 'owner' })
    await run(env, 'drafts.send', {
      id: draft.id,
      idempotencyKey: 'reply-attempt-number-one',
    })
    expect(env.sent).toHaveLength(1)
    const message = env.sent[0] as EmailMessageBuilder & {
      cc?: string[]
      headers?: Record<string, string>
    }
    expect(message.to).toBe('reader@example.net')
    expect(message.cc).toEqual(['team@example.com'])
    expect(message.headers?.['In-Reply-To']).toBe('<q1@example.net>')
    const [attachment] = message.attachments ?? []
    expect(attachment?.filename).toBe('reply.txt')
    expect(new TextDecoder().decode(attachment?.content as Uint8Array)).toBe(
      'reply',
    )

    const status = await run(env, 'messages.get', {
      id: 'msg_1',
      includeBody: false,
    })
    expect(status.status).toBe('read')
  })
})

describe('attachments and listing', () => {
  it('signs short-lived download paths', async () => {
    const env = await createTestEnv()
    const attachment = await run(env, 'attachments.get', { id: 'att_1' })
    const download = attachment.download as { path: string }
    const url = new URL(download.path, 'https://mail.example.com')
    const expires = url.searchParams.get('expires') ?? undefined
    const signature = url.searchParams.get('signature') ?? undefined
    expect(
      await verifyDownloadSignature(env, 'att_1', expires, signature),
    ).toBe(true)
    expect(
      await verifyDownloadSignature(env, 'att_2', expires, signature),
    ).toBe(false)
    expect(
      await verifyDownloadSignature(
        env,
        'att_1',
        expires,
        signature,
        Date.now() + 16 * 60 * 1_000,
      ),
    ).toBe(false)
    expect(attachment.contentBase64).toBeUndefined()
  })

  it('filters messages by several statuses', async () => {
    const env = await createTestEnv()
    const inbox = await run(env, 'messages.list', {
      statuses: ['unread', 'read'],
    })
    expect((inbox.items as unknown[]).length).toBe(1)
    const archived = await run(env, 'messages.list', { statuses: ['archived'] })
    expect((archived.items as unknown[]).length).toBe(0)
  })
})

describe('sent-mail webhooks', () => {
  it('delivers message.sent when enabled and records the delivery', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const env = await createTestEnv({
      MAILROOM_SEND_MODE: 'dry-run',
      WEBHOOK_URL: 'https://hooks.example.org/mail',
      WEBHOOK_SECRET: 'webhook-secret-0123456789',
      WEBHOOK_EVENTS: 'message.received,message.sent',
    })
    const draft = await run(env, 'drafts.compose', {
      inboxId: 'inb_1',
      to: ['ann@example.org'],
      subject: 'Hello',
      text: 'Hi Ann',
    })
    await run(env, 'drafts.approve', { id: draft.id, approvedBy: 'owner' })
    await run(env, 'drafts.send', {
      id: draft.id,
      idempotencyKey: 'hook-0123456789abcdef',
    })
    expect(fetch).toHaveBeenCalledOnce()
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.type).toBe('message.sent')
    expect(body.data.message).toMatchObject({
      subject: 'Hello',
      direction: 'outbound',
    })
    const status = await run(env, 'notifications.status', {})
    expect(status.recent).toMatchObject([
      { channel: 'webhook', event: 'message.sent', state: 'delivered' },
    ])
  })
})
