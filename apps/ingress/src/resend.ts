import type { outboundMessageSchema } from '@mailroom/core'

type OutboundMessage = ReturnType<typeof outboundMessageSchema.parse>

export const RESEND_API_URL = 'https://api.resend.com/emails'

/** A Message-ID on the sender's own domain, so replies can thread back. */
export function newMessageId(from: string): string {
  const domain = from.split('@').at(-1)?.toLowerCase() || 'mailroom.invalid'
  return `<${crypto.randomUUID()}@${domain}>`
}

/** Maps Mailroom's outbound message onto the body of Resend's POST /emails. */
export function resendPayload(
  message: OutboundMessage,
  messageId: string,
): Record<string, unknown> {
  const headers: Record<string, string> = { 'Message-ID': messageId }
  if (message.inReplyTo) headers['In-Reply-To'] = message.inReplyTo
  if (message.references?.length) {
    headers.References = message.references.join(' ')
  }
  return {
    from: message.from,
    to: Array.isArray(message.to) ? message.to : [message.to],
    subject: message.subject,
    text: message.text,
    ...(message.cc?.length ? { cc: message.cc } : {}),
    ...(message.replyTo ? { reply_to: [message.replyTo] } : {}),
    ...(message.html ? { html: message.html } : {}),
    headers,
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: attachment.contentBase64,
            content_type: attachment.contentType,
          })),
        }
      : {}),
  }
}

export class ResendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Sends through Resend and returns the Message-ID Mailroom should record. */
export async function sendWithResend(
  apiKey: string,
  message: OutboundMessage,
  idempotencyKey: string,
): Promise<{ messageId: string; providerId: string }> {
  const messageId = newMessageId(message.from)
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...(idempotencyKey
        ? { 'idempotency-key': idempotencyKey.slice(0, 256) }
        : {}),
    },
    body: JSON.stringify(resendPayload(message, messageId)),
  })
  const payload = (await response.json().catch(() => null)) as {
    id?: string
    message?: string
  } | null
  if (!response.ok || !payload?.id) {
    throw new ResendError(
      `Resend rejected the email (${response.status}): ${payload?.message ?? 'no detail'}`,
      response.status,
    )
  }
  return { messageId, providerId: payload.id }
}
