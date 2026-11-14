import { hmacHex } from './signing.js'
import type { DeliveryResult } from './telegram.js'
import { telegramNotificationMailboxes } from './telegram.js'

export const WEBHOOK_EVENTS = ['message.received', 'message.sent'] as const
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number] | 'test'

export type WebhookEvent = {
  id: string
  type: WebhookEventType
  createdAt: string
  data: Record<string, unknown>
}

type WebhookEnv = Pick<
  Env,
  | 'WEBHOOK_URL'
  | 'WEBHOOK_SECRET'
  | 'WEBHOOK_EVENTS'
  | 'WEBHOOK_NOTIFY_MAILBOXES'
>

const RETRY_DELAYS_MS = [0, 500, 2_000]

export function webhookUrl(env: WebhookEnv): URL | null {
  if (!env.WEBHOOK_URL?.trim()) return null
  try {
    const url = new URL(env.WEBHOOK_URL.trim())
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** Comma-separated event names; defaults to new inbound mail only. */
export function webhookEvents(env: WebhookEnv): string[] {
  const configured = (env.WEBHOOK_EVENTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is string =>
      (WEBHOOK_EVENTS as readonly string[]).includes(value),
    )
  return configured.length ? configured : ['message.received']
}

/** An empty mailbox filter sends events for every mailbox. */
export function webhookMailboxEnabled(
  env: WebhookEnv,
  mailbox: string,
): boolean {
  if (!env.WEBHOOK_NOTIFY_MAILBOXES?.trim()) return true
  const configured = telegramNotificationMailboxes(env.WEBHOOK_NOTIFY_MAILBOXES)
  return (
    configured.includes('*') ||
    configured.includes(mailbox.trim().toLowerCase())
  )
}

export async function webhookSignature(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  return `v1=${await hmacHex(secret, `${timestamp}.${body}`)}`
}

export async function deliverWebhook(
  env: WebhookEnv,
  event: WebhookEvent,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeliveryResult> {
  const url = webhookUrl(env)
  if (!url) {
    return {
      state: 'skipped',
      attempts: 0,
      error: env.WEBHOOK_URL
        ? 'WEBHOOK_URL must be a valid https URL.'
        : 'Webhook is not configured.',
    }
  }
  if (!env.WEBHOOK_SECRET || env.WEBHOOK_SECRET.length < 16) {
    return {
      state: 'skipped',
      attempts: 0,
      error: 'WEBHOOK_SECRET must be set to at least 16 characters.',
    }
  }
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const body = JSON.stringify(event)
  let statusCode: number | undefined
  let error = ''
  let attempts = 0
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await sleep(delay)
    attempts += 1
    const timestamp = String(Math.floor(Date.now() / 1000))
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Mailroom-Webhook/1',
          'x-mailroom-event': event.type,
          'x-mailroom-delivery': event.id,
          'x-mailroom-timestamp': timestamp,
          'x-mailroom-signature': await webhookSignature(
            env.WEBHOOK_SECRET,
            timestamp,
            body,
          ),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      statusCode = response.status
      if (response.status >= 200 && response.status < 300) {
        return { state: 'delivered', attempts, statusCode }
      }
      error = `HTTP ${response.status}`
      if (response.status !== 429 && response.status < 500) break
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
  }
  console.error('mailroom_webhook_failed', {
    event: event.type,
    statusCode,
    error,
  })
  return {
    state: 'failed',
    attempts,
    ...(statusCode ? { statusCode } : {}),
    error: error.slice(0, 500),
  }
}
