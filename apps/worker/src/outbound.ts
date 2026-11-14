import { sha256Hex, signRelayRequest } from '@mailroom/core'
import { relaySecretForAddress } from './relay-secrets.js'
import { base64ToBytes } from './signing.js'

export type OutboundAttachment = {
  filename: string
  contentType: string
  contentBase64: string
}

export type OutboundMessage = {
  from: string
  to: string | string[]
  cc?: string[]
  replyTo?: string | null
  subject: string
  text: string
  html?: string | null
  inReplyTo?: string | null
  references?: string[]
  attachments?: OutboundAttachment[]
}

export function sendMode(
  env: Pick<Env, 'MAILROOM_SEND_MODE'>,
): 'live' | 'dry-run' {
  return String(env.MAILROOM_SEND_MODE) === 'dry-run' ? 'dry-run' : 'live'
}

export function emailBuilder(message: OutboundMessage): EmailMessageBuilder {
  const headers: Record<string, string> = {}
  if (message.inReplyTo) headers['In-Reply-To'] = message.inReplyTo
  if (message.references?.length) {
    headers.References = message.references.join(' ')
  }
  return {
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.cc?.length ? { cc: message.cc } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.html ? { html: message.html } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            disposition: 'attachment' as const,
            filename: attachment.filename,
            type: attachment.contentType,
            content: base64ToBytes(attachment.contentBase64),
          })),
        }
      : {}),
  }
}

async function sendThroughRelay(
  env: Env,
  relayUrl: string,
  message: OutboundMessage,
  idempotencyKey: string,
): Promise<EmailSendResult> {
  const url = new URL('/v1/send', relayUrl)
  const body = JSON.stringify(message)
  const signed = {
    timestamp: String(Date.now()),
    idempotencyKey,
    method: 'POST',
    path: url.pathname,
    bodySha256: await sha256Hex(body),
  }
  const signature = await signRelayRequest(
    relaySecretForAddress(env, message.from),
    signed,
  )
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mailroom-timestamp': signed.timestamp,
      'x-mailroom-idempotency-key': idempotencyKey,
      'x-mailroom-body-sha256': signed.bodySha256,
      'x-mailroom-signature': signature,
    },
    body,
  })
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean
    messageId?: string
    error?: { message?: string }
  } | null
  if (!response.ok || !payload?.ok || !payload.messageId) {
    throw new Error(
      payload?.error?.message ??
        `The outbound relay returned HTTP ${response.status}.`,
    )
  }
  return { messageId: payload.messageId }
}

export async function sendOutbound(
  env: Env,
  message: OutboundMessage,
  relayUrl: string | null,
  idempotencyKey: string,
): Promise<EmailSendResult> {
  if (sendMode(env) === 'dry-run') {
    console.log('mailroom_send_dry_run', {
      from: message.from,
      recipients:
        (Array.isArray(message.to) ? message.to.length : 1) +
        (message.cc?.length ?? 0),
      attachments: message.attachments?.length ?? 0,
      transport: relayUrl ? 'relay' : 'email-service',
    })
    return { messageId: `<dry-run.${crypto.randomUUID()}@mailroom.invalid>` }
  }
  return relayUrl
    ? sendThroughRelay(env, relayUrl, message, idempotencyKey)
    : env.EMAIL.send(emailBuilder(message))
}
