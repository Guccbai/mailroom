import { newId, nowIso } from './database.js'
import {
  type DeliveryResult,
  notifyTelegram,
  sendTelegramText,
  telegramText,
} from './telegram.js'
import {
  deliverWebhook,
  type WebhookEvent,
  type WebhookEventType,
  webhookEvents,
  webhookMailboxEnabled,
} from './webhook.js'

export type NotifiableMessage = {
  id: string
  threadId: string
  inboxId: string
  mailbox: string
  direction: 'inbound' | 'outbound'
  from: string
  to: string[]
  cc: string[]
  subject: string
  preview: string
  receivedAt: string
  attachments: Array<{
    id: string
    filename: string | null
    contentType: string | null
    sizeBytes: number
  }>
}

export function messageLink(
  env: Pick<Env, 'MAILROOM_PUBLIC_URL'>,
  messageId: string,
): string | null {
  if (!env.MAILROOM_PUBLIC_URL?.trim()) return null
  try {
    const url = new URL(env.MAILROOM_PUBLIC_URL.trim())
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return null
    url.pathname = '/'
    url.search = ''
    url.hash = `#/message/${encodeURIComponent(messageId)}`
    return url.toString()
  } catch {
    return null
  }
}

export function messageEvent(
  env: Pick<Env, 'MAILROOM_PUBLIC_URL'>,
  type: WebhookEventType,
  message: NotifiableMessage,
): WebhookEvent {
  return {
    id: newId('evt'),
    type,
    createdAt: nowIso(),
    data: {
      message,
      links: { web: messageLink(env, message.id) },
    },
  }
}

export async function recordDelivery(
  db: D1Database,
  channel: 'telegram' | 'webhook',
  event: string,
  messageId: string | null,
  result: DeliveryResult,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO notification_deliveries
          (id, channel, event, message_id, state, attempts, status_code, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId('ntf'),
        channel,
        event,
        messageId,
        result.state,
        result.attempts,
        result.statusCode ?? null,
        result.error?.slice(0, 500) ?? null,
        nowIso(),
      )
      .run()
  } catch (error) {
    console.error('mailroom_notification_log_failed', {
      channel,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Fan out one stored message to the configured channels. Telegram covers new
 * inbound mail only. Webhooks follow WEBHOOK_EVENTS. Failures are logged and
 * never undo the stored message.
 */
export async function notifyMessage(
  env: Env,
  type: 'message.received' | 'message.sent',
  message: NotifiableMessage,
): Promise<void> {
  const tasks: Array<Promise<void>> = []
  if (type === 'message.received' && env.TELEGRAM_BOT_TOKEN) {
    tasks.push(
      notifyTelegram(env, {
        id: message.id,
        from: message.from,
        to: message.mailbox,
        subject: message.subject,
        preview: message.preview,
        attachments: message.attachments,
        link: messageLink(env, message.id),
      }).then((result) =>
        result.state === 'skipped'
          ? undefined
          : recordDelivery(env.DB, 'telegram', type, message.id, result),
      ),
    )
  }
  if (
    env.WEBHOOK_URL &&
    webhookEvents(env).includes(type) &&
    webhookMailboxEnabled(env, message.mailbox)
  ) {
    tasks.push(
      deliverWebhook(env, messageEvent(env, type, message)).then((result) =>
        recordDelivery(env.DB, 'webhook', type, message.id, result),
      ),
    )
  }
  await Promise.all(tasks)
}

export function sampleMessage(): NotifiableMessage {
  return {
    id: 'msg_test',
    threadId: 'thr_test',
    inboxId: 'inb_test',
    mailbox: 'hello@example.com',
    direction: 'inbound',
    from: 'sender@example.net',
    to: ['hello@example.com'],
    cc: [],
    subject: 'Mailroom test notification',
    preview: 'This is a test event from Mailroom. No real email was received.',
    receivedAt: nowIso(),
    attachments: [],
  }
}

export async function sendTestNotifications(
  env: Env,
  channel: 'telegram' | 'webhook' | 'all',
): Promise<Record<string, DeliveryResult>> {
  const message = sampleMessage()
  const results: Record<string, DeliveryResult> = {}
  if (channel === 'telegram' || channel === 'all') {
    results.telegram = await sendTelegramText(
      env,
      telegramText({
        id: message.id,
        from: message.from,
        to: message.mailbox,
        subject: message.subject,
        preview: message.preview,
        link: null,
      }),
    )
    await recordDelivery(env.DB, 'telegram', 'test', null, results.telegram)
  }
  if (channel === 'webhook' || channel === 'all') {
    results.webhook = await deliverWebhook(env, {
      ...messageEvent(env, 'test', message),
    })
    await recordDelivery(env.DB, 'webhook', 'test', null, results.webhook)
  }
  return results
}
