import { MAILROOM_VERSION } from '@mailroom/core'
import { sendMode } from '../outbound.js'
import { telegramNotificationMailboxes } from '../telegram.js'
import type { OperationContext } from '../types.js'
import { webPasswordConfigured } from '../web-auth.js'
import { webhookUrl } from '../webhook.js'

export async function systemStatus(
  context: OperationContext,
): Promise<unknown> {
  const database = await context.env.DB.prepare('SELECT 1 AS value').first<{
    value: number
  }>()
  return {
    service: 'mailroom',
    version: MAILROOM_VERSION,
    environment: context.env.ENVIRONMENT,
    requestId: context.requestId,
    bindings: {
      database: database?.value === 1,
      rawEmail: Boolean(context.env.RAW),
      ai: Boolean(context.env.AI),
      aiSearch: Boolean(context.env.AI_SEARCH),
      email: Boolean(context.env.EMAIL),
      telegram: Boolean(
        context.env.TELEGRAM_BOT_TOKEN &&
          context.env.TELEGRAM_CHAT_ID &&
          telegramNotificationMailboxes(context.env.TELEGRAM_NOTIFY_MAILBOXES)
            .length,
      ),
      webhook: Boolean(
        webhookUrl(context.env) &&
          (context.env.WEBHOOK_SECRET?.length ?? 0) >= 16,
      ),
      oauth: Boolean(context.env.OAUTH_KV),
    },
    sending: { mode: sendMode(context.env) },
    web: { passwordConfigured: webPasswordConfigured(context.env) },
    mcp: {
      path: '/mcp',
      dedicatedToken: Boolean(context.env.MAILROOM_MCP_TOKEN),
    },
    automation: {
      model: context.env.AI_MODEL,
      automaticSending: false,
    },
  }
}
