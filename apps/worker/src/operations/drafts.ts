import {
  type AttachmentInput,
  MailroomError,
  normalizeMessageId,
  normalizeSubject,
  plainTextPreview,
} from '@mailroom/core'
import { addressParser } from 'postal-mime'
import {
  deleteStoredAttachments,
  draftAttachmentStatements,
  loadDraftAttachments,
  readAttachmentBase64,
  signedDownloadPath,
  storeDraftAttachments,
} from '../attachments.js'
import {
  batchOrThrow,
  cursorFor,
  cursorFrom,
  markPriorInboundMessagesRead,
  newId,
  nowIso,
  parseJson,
} from '../database.js'
import { emailAddresses } from '../email-addresses.js'
import { notifyMessage } from '../notifications.js'
import {
  inputNumber,
  inputString,
  inputStrings,
  optionalString,
} from '../operation-input.js'
import { sendOutbound } from '../outbound.js'
import { indexMessage } from '../search.js'
import type { OperationContext } from '../types.js'

type Input = Record<string, unknown>
type Row = Record<string, unknown>

export function draftRecipient(message: Row): string {
  if (typeof message.message_reply_to === 'string') {
    const address = emailAddresses(addressParser(message.message_reply_to))[0]
    if (address) return address
  }
  return String(message.sender)
}

function draftTo(row: Row): string[] {
  const to = parseJson<string[]>(row.to_addresses, [])
  return to.length ? to : [String(row.recipient)]
}

function draftSummary(row: Row): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind ?? 'reply',
    messageId: row.message_id,
    threadId: row.thread_id,
    inboxId: row.inbox_id,
    status: row.status,
    recipient: row.recipient,
    to: draftTo(row),
    cc: parseJson<string[]>(row.cc_addresses, []),
    attachmentCount: Number(row.attachment_count ?? 0),
    subject: row.subject,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  }
}

export async function listDrafts(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const clauses = ['1 = 1']
  const values: unknown[] = []
  const status = optionalString(input, 'status')
  if (status) {
    clauses.push('status = ?')
    values.push(status)
  }
  const threadId = optionalString(input, 'threadId')
  if (threadId) {
    clauses.push('thread_id = ?')
    values.push(threadId)
  }
  const cursor = cursorFrom(input.cursor)
  if (cursor) {
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
    values.push(cursor.at, cursor.at, cursor.id)
  }
  const limit = inputNumber(input, 'limit')
  const result = await context.env.DB.prepare(
    `SELECT * FROM drafts WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...values, limit + 1)
    .all<Row>()
  const rows = result.results.slice(0, limit)
  return {
    items: rows.map(draftSummary),
    nextCursor:
      result.results.length > limit
        ? cursorFor({
            at: String(rows.at(-1)?.created_at),
            id: String(rows.at(-1)?.id),
          })
        : null,
  }
}

export async function getDraft(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const id = inputString(input, 'id')
  const draft = await context.env.DB.prepare(
    'SELECT * FROM drafts WHERE id = ?',
  )
    .bind(id)
    .first<Row>()
  if (!draft) throw new MailroomError('NOT_FOUND', `Draft ${id} was not found.`)
  const events = await context.env.DB.prepare(
    `SELECT action, actor, note, created_at
    FROM draft_events WHERE draft_id = ? ORDER BY created_at, id`,
  )
    .bind(id)
    .all<Row>()
  const attachments = await loadDraftAttachments(context.env.DB, id)
  return {
    ...draftSummary(draft),
    attachments: await Promise.all(
      attachments.map(async (attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        download: await signedDownloadPath(context.env, attachment.id),
      })),
    ),
    sender: draft.sender,
    replyTo: draft.reply_to,
    text: draft.text_body,
    html: draft.html_body,
    prompt: draft.prompt_id
      ? { id: draft.prompt_id, hash: draft.prompt_hash }
      : null,
    model: draft.model,
    providerMessageId: draft.provider_message_id,
    lastError: draft.last_error,
    events: events.results.map((event) => ({
      action: event.action,
      actor: event.actor,
      note: event.note,
      createdAt: event.created_at,
    })),
  }
}

function attachmentInputs(input: Input): AttachmentInput[] {
  return Array.isArray(input.attachments)
    ? (input.attachments as AttachmentInput[])
    : []
}

export type NewDraft = {
  id: string
  kind: 'reply' | 'new'
  messageId: string | null
  threadId: string | null
  inboxId: string
  to: string[]
  cc: string[]
  sender: string
  replyTo: string | null
  subject: string
  text: string
  html: string | null
  source: string
  promptId?: string | null
  promptHash?: string | null
  model?: string | null
}

export async function insertDraft(
  context: OperationContext,
  draft: NewDraft,
  attachments: AttachmentInput[],
): Promise<void> {
  const stored = await storeDraftAttachments(
    context.env.RAW,
    draft.id,
    attachments,
  )
  const now = nowIso()
  try {
    await batchOrThrow(context.env.DB, [
      context.env.DB.prepare(
        `INSERT INTO drafts (
          id, message_id, thread_id, inbox_id, kind, status, recipient,
          to_addresses, cc_addresses, sender, reply_to, subject, text_body,
          html_body, attachment_count, validation, source, prompt_id,
          prompt_hash, model, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?
        )`,
      ).bind(
        draft.id,
        draft.messageId,
        draft.threadId,
        draft.inboxId,
        draft.kind,
        draft.to[0],
        JSON.stringify(draft.to),
        JSON.stringify(draft.cc),
        draft.sender,
        draft.replyTo,
        draft.subject,
        draft.text,
        draft.html,
        stored.length,
        draft.source,
        draft.promptId ?? null,
        draft.promptHash ?? null,
        draft.model ?? null,
        now,
        now,
      ),
      ...draftAttachmentStatements(context.env.DB, draft.id, stored),
      context.env.DB.prepare(
        `INSERT INTO draft_events
          (id, draft_id, action, actor, note, created_at)
        VALUES (?, ?, 'created', ?, ?, ?)`,
      ).bind(newId('evt'), draft.id, draft.source, null, now),
    ])
  } catch (error) {
    await deleteStoredAttachments(context.env.RAW, stored)
    throw error
  }
}

export async function createDraft(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const sourceMessageId = inputString(input, 'messageId')
  const sourceMessage = await context.env.DB.prepare(
    `SELECT m.*, i.local_part, d.domain, d.from_address, d.reply_to,
      json_extract(m.headers, '$."reply-to"[0]') AS message_reply_to
    FROM messages m
    JOIN inboxes i ON i.id = m.inbox_id
    JOIN domains d ON d.id = i.domain_id
    WHERE m.id = ?`,
  )
    .bind(sourceMessageId)
    .first<Row>()
  if (!sourceMessage) {
    throw new MailroomError(
      'NOT_FOUND',
      `Message ${sourceMessageId} was not found.`,
    )
  }
  const text = inputString(input, 'text')
  const sender =
    (sourceMessage.from_address as string | null) ??
    `${sourceMessage.local_part}@${sourceMessage.domain}`
  const recipient = draftRecipient(sourceMessage)
  const originalSubject = String(sourceMessage.subject ?? '')
  const subject =
    optionalString(input, 'subject') ??
    (originalSubject.toLowerCase().startsWith('re:')
      ? originalSubject
      : `Re: ${originalSubject || '(no subject)'}`)
  const id = newId('drf')
  const attachments = attachmentInputs(input)
  const cc = inputStrings(input, 'cc')
  await insertDraft(
    context,
    {
      id,
      kind: 'reply',
      messageId: sourceMessageId,
      threadId: String(sourceMessage.thread_id),
      inboxId: String(sourceMessage.inbox_id),
      to: [recipient],
      cc,
      sender,
      replyTo: (sourceMessage.reply_to as string | null) ?? null,
      subject,
      text,
      html: optionalString(input, 'html') ?? null,
      source: inputString(input, 'source'),
      promptId: optionalString(input, 'promptId') ?? null,
      promptHash: optionalString(input, 'promptHash') ?? null,
      model: optionalString(input, 'model') ?? null,
    },
    attachments,
  )
  return {
    id,
    status: 'pending',
    recipient,
    cc,
    sender,
    subject,
    attachmentCount: attachments.length,
  }
}

export async function resolveComposeInbox(
  context: OperationContext,
  input: Input,
): Promise<{ inboxId: string; sender: string; replyTo: string | null }> {
  const inboxId = optionalString(input, 'inboxId')
  const from = optionalString(input, 'from')?.toLowerCase()
  const row = inboxId
    ? await context.env.DB.prepare(
        `SELECT i.id, i.local_part, i.enabled, d.domain, d.from_address,
          d.reply_to, d.enabled AS domain_enabled
        FROM inboxes i JOIN domains d ON d.id = i.domain_id WHERE i.id = ?`,
      )
        .bind(inboxId)
        .first<Row>()
    : await context.env.DB.prepare(
        `SELECT i.id, i.local_part, i.enabled, d.domain, d.from_address,
          d.reply_to, d.enabled AS domain_enabled
        FROM inboxes i JOIN domains d ON d.id = i.domain_id
        WHERE (i.local_part || '@' || d.domain) = ?
          OR lower(coalesce(d.from_address, '')) = ?
        ORDER BY (i.local_part || '@' || d.domain) = ? DESC
        LIMIT 1`,
      )
        .bind(from, from, from)
        .first<Row>()
  if (!row) {
    throw new MailroomError(
      'NOT_FOUND',
      inboxId
        ? `Inbox ${inboxId} was not found.`
        : `No configured inbox can send as ${from}.`,
    )
  }
  if (row.enabled !== 1 || row.domain_enabled !== 1) {
    throw new MailroomError('CONFLICT', 'The sending inbox is disabled.')
  }
  const inboxAddress = `${row.local_part}@${row.domain}`
  return {
    inboxId: String(row.id),
    sender: from ?? inboxAddress,
    replyTo: (row.reply_to as string | null) ?? null,
  }
}

export async function composeDraft(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const inbox = await resolveComposeInbox(context, input)
  const id = newId('drf')
  const to = inputStrings(input, 'to')
  const cc = inputStrings(input, 'cc')
  const subject = inputString(input, 'subject')
  const attachments = attachmentInputs(input)
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
      text: inputString(input, 'text'),
      html: optionalString(input, 'html') ?? null,
      source: inputString(input, 'source'),
    },
    attachments,
  )
  return {
    id,
    kind: 'new',
    status: 'pending',
    to,
    cc,
    sender: inbox.sender,
    subject,
    attachmentCount: attachments.length,
  }
}

export async function approveDraft(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const id = inputString(input, 'id')
  const current = await context.env.DB.prepare(
    'SELECT status FROM drafts WHERE id = ?',
  )
    .bind(id)
    .first<Row>()
  if (!current)
    throw new MailroomError('NOT_FOUND', `Draft ${id} was not found.`)
  if (current.status === 'approved') return { id, status: 'approved' }
  if (current.status !== 'pending') {
    throw new MailroomError(
      'CONFLICT',
      `Only a pending draft can be approved; this draft is ${current.status}.`,
    )
  }
  const now = nowIso()
  const actor = inputString(input, 'approvedBy')
  await batchOrThrow(context.env.DB, [
    context.env.DB.prepare(
      "UPDATE drafts SET status = 'approved', updated_at = ? WHERE id = ?",
    ).bind(now, id),
    context.env.DB.prepare(
      `INSERT INTO draft_events
        (id, draft_id, action, actor, note, created_at)
      VALUES (?, ?, 'approved', ?, ?, ?)`,
    ).bind(newId('evt'), id, actor, optionalString(input, 'note') ?? null, now),
  ])
  return { id, status: 'approved', approvedBy: actor, approvedAt: now }
}

export async function rejectDraft(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const id = inputString(input, 'id')
  const current = await context.env.DB.prepare(
    'SELECT status FROM drafts WHERE id = ?',
  )
    .bind(id)
    .first<{ status: string }>()
  if (!current)
    throw new MailroomError('NOT_FOUND', `Draft ${id} was not found.`)
  if (current.status === 'rejected') return { id, status: 'rejected' }
  if (!['pending', 'approved'].includes(current.status)) {
    throw new MailroomError(
      'CONFLICT',
      `A ${current.status} draft cannot be rejected.`,
    )
  }
  const now = nowIso()
  const actor = inputString(input, 'rejectedBy')
  const reason = inputString(input, 'reason')
  await batchOrThrow(context.env.DB, [
    context.env.DB.prepare(
      "UPDATE drafts SET status = 'rejected', updated_at = ? WHERE id = ?",
    ).bind(now, id),
    context.env.DB.prepare(
      `INSERT INTO draft_events
        (id, draft_id, action, actor, note, created_at)
      VALUES (?, ?, 'rejected', ?, ?, ?)`,
    ).bind(newId('evt'), id, actor, reason, now),
  ])
  return { id, status: 'rejected', rejectedBy: actor, rejectedAt: now }
}

export async function sendDraft(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const id = inputString(input, 'id')
  const idempotencyKey = inputString(input, 'idempotencyKey')
  const previous = await context.env.DB.prepare(
    `SELECT state, provider_message_id, error FROM outbound_attempts
    WHERE idempotency_key = ?`,
  )
    .bind(idempotencyKey)
    .first<Row>()
  if (previous) {
    return {
      id,
      idempotentReplay: true,
      state: previous.state,
      providerMessageId: previous.provider_message_id,
      error: previous.error,
    }
  }
  const draft = await context.env.DB.prepare(
    `SELECT d.*, m.rfc_message_id, m.message_references,
      coalesce(d.inbox_id, m.inbox_id) AS sending_inbox_id, dom.relay_url
    FROM drafts d
    LEFT JOIN messages m ON m.id = d.message_id
    JOIN inboxes i ON i.id = coalesce(d.inbox_id, m.inbox_id)
    JOIN domains dom ON dom.id = i.domain_id
    WHERE d.id = ?`,
  )
    .bind(id)
    .first<Row>()
  if (!draft) throw new MailroomError('NOT_FOUND', `Draft ${id} was not found.`)
  if (draft.status !== 'approved') {
    throw new MailroomError(
      'CONFLICT',
      `Only an approved draft can be sent; this draft is ${draft.status}.`,
    )
  }
  const attemptId = newId('out')
  const startedAt = nowIso()
  await batchOrThrow(context.env.DB, [
    context.env.DB.prepare(
      `INSERT INTO outbound_attempts
        (id, draft_id, idempotency_key, transport, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'sending', ?, ?)`,
    ).bind(
      attemptId,
      id,
      idempotencyKey,
      draft.relay_url ? 'relay' : 'email-service',
      startedAt,
      startedAt,
    ),
    context.env.DB.prepare(
      "UPDATE drafts SET status = 'sending', updated_at = ? WHERE id = ?",
    ).bind(startedAt, id),
  ])

  try {
    const references = parseJson<string[]>(draft.message_references, [])
    if (draft.rfc_message_id) references.push(String(draft.rfc_message_id))
    const to = draftTo(draft)
    const cc = parseJson<string[]>(draft.cc_addresses, [])
    const inboxId = String(draft.sending_inbox_id)
    const storedAttachments = await loadDraftAttachments(context.env.DB, id)
    const attachments = await Promise.all(
      storedAttachments.map(async (attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        contentBase64: await readAttachmentBase64(
          context.env.RAW,
          attachment.key,
        ),
      })),
    )
    const sent = await sendOutbound(
      context.env,
      {
        from: String(draft.sender),
        to: to.length === 1 ? String(to[0]) : to,
        ...(cc.length ? { cc } : {}),
        replyTo: draft.reply_to ? String(draft.reply_to) : null,
        subject: String(draft.subject),
        text: String(draft.text_body),
        html: draft.html_body ? String(draft.html_body) : null,
        inReplyTo: draft.rfc_message_id ? String(draft.rfc_message_id) : null,
        references,
        ...(attachments.length ? { attachments } : {}),
      },
      draft.relay_url ? String(draft.relay_url) : null,
      idempotencyKey,
    )
    const sentAt = nowIso()
    const messageId = newId('msg')
    const threadId = draft.thread_id ? String(draft.thread_id) : newId('thr')
    const rfcMessageId = normalizeMessageId(sent.messageId)
    const subject = String(draft.subject)
    const text = String(draft.text_body)
    const preview = plainTextPreview(text || subject)
    const outboundAttachments = storedAttachments.map((attachment) => ({
      ...attachment,
      messageAttachmentId: newId('att'),
    }))
    await batchOrThrow(context.env.DB, [
      draft.thread_id
        ? markPriorInboundMessagesRead(context.env.DB, threadId, sentAt)
        : context.env.DB.prepare(
            `INSERT INTO threads
              (id, inbox_id, normalized_subject, latest_at, message_count,
                created_at, updated_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)`,
          ).bind(
            threadId,
            inboxId,
            normalizeSubject(subject),
            sentAt,
            sentAt,
            sentAt,
          ),
      context.env.DB.prepare(
        `INSERT INTO messages (
          id, thread_id, inbox_id, direction, status, rfc_message_id,
          in_reply_to, message_references, sender, recipients, cc, subject,
          normalized_subject, preview, text_body, html_body, headers, raw_key,
          size_bytes, attachment_count, search_status, provider_message_id,
          received_at, created_at
        ) VALUES (
          ?, ?, ?, 'outbound', 'read', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          NULL, NULL, ?, ?, 'pending', ?, ?, ?
        )`,
      ).bind(
        messageId,
        threadId,
        inboxId,
        rfcMessageId,
        draft.rfc_message_id ?? null,
        JSON.stringify(references),
        draft.sender,
        JSON.stringify(to),
        JSON.stringify(cc),
        subject,
        normalizeSubject(subject),
        preview,
        text,
        draft.html_body ?? null,
        new TextEncoder().encode(text).byteLength +
          storedAttachments.reduce((sum, item) => sum + item.sizeBytes, 0),
        storedAttachments.length,
        sent.messageId,
        sentAt,
        sentAt,
      ),
      ...outboundAttachments.map((attachment) =>
        context.env.DB.prepare(
          `INSERT INTO attachments
            (id, message_id, filename, content_type, content_id, disposition,
              size_bytes, r2_key, created_at)
          VALUES (?, ?, ?, ?, NULL, 'attachment', ?, ?, ?)`,
        ).bind(
          attachment.messageAttachmentId,
          messageId,
          attachment.filename,
          attachment.contentType,
          attachment.sizeBytes,
          attachment.key,
          sentAt,
        ),
      ),
      context.env.DB.prepare(
        `INSERT INTO message_fts
          (message_id, inbox_id, subject, sender, body, classification)
        VALUES (?, ?, ?, ?, ?, '')`,
      ).bind(messageId, inboxId, subject, draft.sender, text),
      context.env.DB.prepare(
        `UPDATE threads SET latest_at = ?, message_count = message_count + 1,
          updated_at = ? WHERE id = ?`,
      ).bind(sentAt, sentAt, threadId),
      context.env.DB.prepare(
        `UPDATE drafts SET status = 'sent', provider_message_id = ?,
          thread_id = ?, sent_at = ?, updated_at = ?, last_error = NULL
        WHERE id = ?`,
      ).bind(sent.messageId, threadId, sentAt, sentAt, id),
      context.env.DB.prepare(
        `UPDATE outbound_attempts SET state = 'sent', provider_message_id = ?,
          updated_at = ? WHERE id = ?`,
      ).bind(sent.messageId, sentAt, attemptId),
      context.env.DB.prepare(
        `INSERT INTO draft_events
          (id, draft_id, action, actor, note, created_at)
        VALUES (?, ?, 'sent', 'mailroom', ?, ?)`,
      ).bind(newId('evt'), id, sent.messageId, sentAt),
    ])
    context.executionCtx.waitUntil(
      Promise.all([
        indexMessage(context.env, {
          id: messageId,
          threadId,
          inboxId,
          mailbox: String(draft.sender),
          direction: 'outbound',
          from: String(draft.sender),
          to,
          cc,
          subject,
          text,
          receivedAt: sentAt,
          status: 'read',
        }),
        notifyMessage(context.env, 'message.sent', {
          id: messageId,
          threadId,
          inboxId,
          mailbox: String(draft.sender),
          direction: 'outbound',
          from: String(draft.sender),
          to,
          cc,
          subject,
          preview,
          receivedAt: sentAt,
          attachments: outboundAttachments.map((attachment) => ({
            id: attachment.messageAttachmentId,
            filename: attachment.filename,
            contentType: attachment.contentType,
            sizeBytes: attachment.sizeBytes,
          })),
        }),
      ]).then(() => undefined),
    )
    return {
      id,
      status: 'sent',
      messageId,
      threadId,
      providerMessageId: sent.messageId,
      sentAt,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failedAt = nowIso()
    await batchOrThrow(context.env.DB, [
      context.env.DB.prepare(
        `UPDATE drafts SET status = 'failed', last_error = ?,
          updated_at = ? WHERE id = ?`,
      ).bind(message.slice(0, 2_000), failedAt, id),
      context.env.DB.prepare(
        `UPDATE outbound_attempts SET state = 'failed', error = ?,
          updated_at = ? WHERE id = ?`,
      ).bind(message.slice(0, 2_000), failedAt, attemptId),
    ])
    throw new MailroomError('REMOTE_ERROR', 'The email could not be sent.', {
      draftId: id,
      attemptId,
    })
  }
}
