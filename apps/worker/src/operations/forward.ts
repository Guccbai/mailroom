import {
  type AttachmentInput,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MailroomError,
} from '@mailroom/core'
import { readAttachmentBase64 } from '../attachments.js'
import { newId, parseJson } from '../database.js'
import {
  inputBoolean,
  inputString,
  inputStrings,
  optionalString,
} from '../operation-input.js'
import type { OperationContext } from '../types.js'
import { insertDraft, resolveComposeInbox } from './drafts.js'

type Input = Record<string, unknown>
type Row = Record<string, unknown>

const SAFE_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i

function forwardSubject(subject: string): string {
  return /^\s*(fwd?|转发)\s*:/i.test(subject) ? subject : `Fwd: ${subject}`
}

function quotedOriginal(message: Row, note: string | undefined): string {
  const to = parseJson<string[]>(message.recipients, [])
  const cc = parseJson<string[]>(message.cc, [])
  const lines = [
    ...(note ? [note, ''] : []),
    '---------- Forwarded message ----------',
    `From: ${String(message.sender)}`,
    `Date: ${String(message.received_at)}`,
    `Subject: ${String(message.subject)}`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    '',
    String(message.text_body ?? message.preview ?? '').trim(),
  ]
  return lines.join('\n')
}

async function originalAttachments(
  context: OperationContext,
  messageId: string,
): Promise<AttachmentInput[]> {
  const result = await context.env.DB.prepare(
    `SELECT filename, content_type, size_bytes, r2_key, disposition
    FROM attachments WHERE message_id = ? ORDER BY created_at, id`,
  )
    .bind(messageId)
    .all<Row>()
  const total = result.results.reduce(
    (sum, row) => sum + Number(row.size_bytes ?? 0),
    0,
  )
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new MailroomError(
      'INVALID_INPUT',
      'The attachments are larger than the 10 MB send limit; forward without attachments.',
    )
  }
  return Promise.all(
    result.results.map(async (row, index) => {
      const type = String(row.content_type ?? '')
      return {
        filename:
          typeof row.filename === 'string' && row.filename.trim()
            ? row.filename.trim()
            : `attachment-${index + 1}`,
        contentType: SAFE_TYPE.test(type) ? type : 'application/octet-stream',
        contentBase64: await readAttachmentBase64(
          context.env.RAW,
          String(row.r2_key),
        ),
      }
    }),
  )
}

export async function forwardDraft(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const messageId = inputString(input, 'messageId')
  const message = await context.env.DB.prepare(
    'SELECT * FROM messages WHERE id = ?',
  )
    .bind(messageId)
    .first<Row>()
  if (!message) {
    throw new MailroomError('NOT_FOUND', `Message ${messageId} was not found.`)
  }
  const inbox = await resolveComposeInbox(context, {
    inboxId: optionalString(input, 'inboxId') ?? String(message.inbox_id),
  })
  const attachments = inputBoolean(input, 'includeAttachments')
    ? await originalAttachments(context, messageId)
    : []
  const id = newId('drf')
  const to = inputStrings(input, 'to')
  const cc = inputStrings(input, 'cc')
  const subject = forwardSubject(String(message.subject))
  await insertDraft(
    context,
    {
      id,
      kind: 'new',
      messageId: null,
      threadId: null,
      inboxId: inbox.inboxId,
      to,
      cc,
      sender: inbox.sender,
      replyTo: inbox.replyTo,
      subject,
      text: quotedOriginal(message, optionalString(input, 'note')),
      html: null,
      source: inputString(input, 'source'),
    },
    attachments,
  )
  return {
    id,
    kind: 'new',
    status: 'pending',
    forwardedMessageId: messageId,
    to,
    cc,
    sender: inbox.sender,
    subject,
    attachmentCount: attachments.length,
  }
}
