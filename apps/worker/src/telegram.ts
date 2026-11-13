export type TelegramMessage = {
  id: string
  from: string
  to: string
  subject: string
  preview: string
  attachments?: Array<{ filename: string | null }>
  link?: string | null
}

export type DeliveryResult = {
  state: 'delivered' | 'failed' | 'skipped'
  attempts: number
  statusCode?: number
  error?: string
}

const TELEGRAM_TEXT_LIMIT = 4_000

export function telegramText(message: TelegramMessage): string {
  const names = (message.attachments ?? [])
    .map((attachment) => attachment.filename || 'unnamed file')
    .slice(0, 5)
  const extra = (message.attachments?.length ?? 0) - names.length
  const lines = [
    '📬 New email',
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject || '(no subject)'}`,
    ...(names.length
      ? [
          `Attachments: ${names.join(', ')}${extra > 0 ? ` and ${extra} more` : ''}`,
        ]
      : []),
    '',
    message.preview,
    '',
    message.link ? `Open: ${message.link}` : `Message: ${message.id}`,
  ]
  return lines.join('\n').slice(0, TELEGRAM_TEXT_LIMIT)
}

export async function sendTelegramText(
  env: Pick<Env, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'>,
  text: string,
): Promise<DeliveryResult> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return {
      state: 'skipped',
      attempts: 0,
      error: 'Telegram is not configured.',
    }
  }
  let lastStatus: number | undefined
  let lastError = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      )
      lastStatus = response.status
      if (response.ok) {
        return {
          state: 'delivered',
          attempts: attempt,
          statusCode: response.status,
        }
      }
      lastError = (await response.text().catch(() => '')).slice(0, 500)
      if (response.status !== 429 && response.status < 500) break
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  console.error('mailroom_telegram_failed', {
    status: lastStatus,
    body: lastError,
  })
  return {
    state: 'failed',
    attempts: 2,
    ...(lastStatus ? { statusCode: lastStatus } : {}),
    error: lastError || 'Telegram request failed.',
  }
}

export async function notifyTelegram(
  env: Env,
  message: TelegramMessage,
): Promise<DeliveryResult> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return {
      state: 'skipped',
      attempts: 0,
      error: 'Telegram is not configured.',
    }
  }
  if (!telegramMailboxEnabled(message.to, env.TELEGRAM_NOTIFY_MAILBOXES)) {
    return {
      state: 'skipped',
      attempts: 0,
      error: 'The mailbox is not in TELEGRAM_NOTIFY_MAILBOXES.',
    }
  }
  return sendTelegramText(env, telegramText(message))
}

/**
 * Exact, case-insensitive mailbox match. The single entry "*" enables every
 * mailbox. An empty or invalid list disables notifications.
 */
export function telegramMailboxEnabled(
  mailbox: string,
  configuredMailboxes: string | undefined,
): boolean {
  const target = mailbox.trim().toLowerCase()
  const configured = telegramNotificationMailboxes(configuredMailboxes)
  return configured.includes('*') || configured.includes(target)
}

export function telegramNotificationMailboxes(
  configuredMailboxes: string | undefined,
): string[] {
  if (!configuredMailboxes?.trim()) return []

  try {
    const parsed: unknown = JSON.parse(configuredMailboxes)
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry) => typeof entry === 'string')
    ) {
      throw new Error('expected a JSON array of mailbox addresses')
    }

    return parsed
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  } catch (error) {
    console.error('mailroom_telegram_config_invalid', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
