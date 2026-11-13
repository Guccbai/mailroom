import { sendTestNotifications } from '../notifications.js'
import { inputNumber } from '../operation-input.js'
import { telegramNotificationMailboxes } from '../telegram.js'
import type { OperationContext } from '../types.js'
import { webhookEvents, webhookUrl } from '../webhook.js'

type Input = Record<string, unknown>
type Row = Record<string, unknown>

export async function notificationsStatus(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const env = context.env
  const limit = inputNumber(input, 'limit')
  const recent = await env.DB.prepare(
    `SELECT channel, event, message_id, state, attempts, status_code, error, created_at
    FROM notification_deliveries ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(limit)
    .all<Row>()
  const url = webhookUrl(env)
  return {
    telegram: {
      configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
      mailboxes: telegramNotificationMailboxes(env.TELEGRAM_NOTIFY_MAILBOXES),
    },
    webhook: {
      configured: Boolean(url && (env.WEBHOOK_SECRET?.length ?? 0) >= 16),
      host: url?.host ?? null,
      invalidUrl: Boolean(env.WEBHOOK_URL && !url),
      secretConfigured: (env.WEBHOOK_SECRET?.length ?? 0) >= 16,
      events: webhookEvents(env),
      mailboxes: env.WEBHOOK_NOTIFY_MAILBOXES?.trim()
        ? telegramNotificationMailboxes(env.WEBHOOK_NOTIFY_MAILBOXES)
        : ['*'],
    },
    recent: recent.results.map((row) => ({
      channel: row.channel,
      event: row.event,
      messageId: row.message_id,
      state: row.state,
      attempts: row.attempts,
      statusCode: row.status_code,
      error: row.error,
      createdAt: row.created_at,
    })),
  }
}

export async function notificationsTest(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const channel = input.channel
  return {
    results: await sendTestNotifications(
      context.env,
      channel === 'telegram' || channel === 'webhook' ? channel : 'all',
    ),
  }
}
