import {
  type AttachmentInput,
  base64ByteLength,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MailroomError,
} from '@mailroom/core'
import { newId, nowIso } from './database.js'
import {
  base64ToBytes,
  bytesToBase64,
  derivedKey,
  signValue,
  verifyValue,
} from './signing.js'

export const DOWNLOAD_TTL_SECONDS = 15 * 60
/** Inline content stays well inside the shared agent output budget. */
export const INLINE_CONTENT_MAX_BYTES = 48 * 1024

const INLINE_SAFE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
])

export type StoredDraftAttachment = {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  key: string
}

export type AttachmentRecord = {
  id: string
  filename: string | null
  contentType: string | null
  sizeBytes: number
  key: string
  kind: 'message' | 'draft'
  ownerId: string
}

export function validateAttachmentSizes(attachments: AttachmentInput[]): void {
  let total = 0
  for (const attachment of attachments) {
    const size = base64ByteLength(attachment.contentBase64)
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new MailroomError(
        'INVALID_INPUT',
        `${attachment.filename} is larger than the 10 MB attachment limit.`,
      )
    }
    total += size
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new MailroomError(
      'INVALID_INPUT',
      'Attachments together are larger than the 10 MB limit.',
    )
  }
}

export async function storeDraftAttachments(
  bucket: R2Bucket,
  draftId: string,
  attachments: AttachmentInput[],
): Promise<StoredDraftAttachment[]> {
  validateAttachmentSizes(attachments)
  return Promise.all(
    attachments.map(async (attachment, index) => {
      const id = newId('dat')
      const bytes = base64ToBytes(attachment.contentBase64)
      const key = `drafts/${draftId}/${String(index + 1).padStart(3, '0')}-${id}`
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: attachment.contentType },
        customMetadata: { draftId, filename: attachment.filename },
      })
      return {
        id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: bytes.byteLength,
        key,
      }
    }),
  )
}

export function draftAttachmentStatements(
  db: D1Database,
  draftId: string,
  attachments: StoredDraftAttachment[],
): D1PreparedStatement[] {
  const createdAt = nowIso()
  return attachments.map((attachment) =>
    db
      .prepare(
        `INSERT INTO draft_attachments
          (id, draft_id, filename, content_type, size_bytes, r2_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        attachment.id,
        draftId,
        attachment.filename,
        attachment.contentType,
        attachment.sizeBytes,
        attachment.key,
        createdAt,
      ),
  )
}

export async function deleteStoredAttachments(
  bucket: R2Bucket,
  attachments: Array<{ key: string }>,
): Promise<void> {
  await Promise.all(attachments.map((item) => bucket.delete(item.key)))
}

export async function loadDraftAttachments(
  db: D1Database,
  draftId: string,
): Promise<StoredDraftAttachment[]> {
  const result = await db
    .prepare(
      `SELECT id, filename, content_type, size_bytes, r2_key
      FROM draft_attachments WHERE draft_id = ? ORDER BY created_at, id`,
    )
    .bind(draftId)
    .all<Record<string, unknown>>()
  return result.results.map((row) => ({
    id: String(row.id),
    filename: String(row.filename),
    contentType: String(row.content_type),
    sizeBytes: Number(row.size_bytes),
    key: String(row.r2_key),
  }))
}

export async function readAttachmentBase64(
  bucket: R2Bucket,
  key: string,
): Promise<string> {
  const object = await bucket.get(key)
  if (!object) {
    throw new MailroomError('NOT_FOUND', 'The attachment content is missing.')
  }
  return bytesToBase64(new Uint8Array(await object.arrayBuffer()))
}

export async function findAttachment(
  db: D1Database,
  id: string,
): Promise<AttachmentRecord | null> {
  if (id.startsWith('dat_')) {
    const row = await db
      .prepare(
        `SELECT id, draft_id, filename, content_type, size_bytes, r2_key
        FROM draft_attachments WHERE id = ?`,
      )
      .bind(id)
      .first<Record<string, unknown>>()
    return row
      ? {
          id: String(row.id),
          filename: row.filename as string | null,
          contentType: row.content_type as string | null,
          sizeBytes: Number(row.size_bytes),
          key: String(row.r2_key),
          kind: 'draft',
          ownerId: String(row.draft_id),
        }
      : null
  }
  const row = await db
    .prepare(
      `SELECT id, message_id, filename, content_type, size_bytes, r2_key
      FROM attachments WHERE id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>()
  return row
    ? {
        id: String(row.id),
        filename: row.filename as string | null,
        contentType: row.content_type as string | null,
        sizeBytes: Number(row.size_bytes),
        key: String(row.r2_key),
        kind: 'message',
        ownerId: String(row.message_id),
      }
    : null
}

export async function signedDownloadPath(
  env: Pick<Env, 'MAILROOM_API_TOKEN'>,
  id: string,
  now = Date.now(),
): Promise<{ path: string; expiresAt: string }> {
  const expires = Math.floor(now / 1000) + DOWNLOAD_TTL_SECONDS
  const key = await derivedKey(env, 'attachment-download')
  const signature = await signValue(key, `${id}.${expires}`)
  return {
    path: `/v1/attachments/${encodeURIComponent(id)}/download?expires=${expires}&signature=${signature}`,
    expiresAt: new Date(expires * 1000).toISOString(),
  }
}

export async function verifyDownloadSignature(
  env: Pick<Env, 'MAILROOM_API_TOKEN'>,
  id: string,
  expires: string | undefined,
  signature: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!expires || !signature || !/^\d{1,12}$/.test(expires)) return false
  if (Number(expires) * 1000 < now) return false
  const key = await derivedKey(env, 'attachment-download')
  return verifyValue(key, `${id}.${expires}`, signature)
}

function contentDispositionFilename(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export async function attachmentResponse(
  bucket: R2Bucket,
  attachment: AttachmentRecord,
  inline: boolean,
): Promise<Response> {
  const object = await bucket.get(attachment.key)
  if (!object) {
    throw new MailroomError('NOT_FOUND', 'The attachment content is missing.')
  }
  const contentType = (attachment.contentType ?? '').toLowerCase()
  const safeInline = inline && INLINE_SAFE_TYPES.has(contentType)
  const filename = attachment.filename || `${attachment.id}.bin`
  return new Response(object.body, {
    headers: {
      'content-type': safeInline ? contentType : 'application/octet-stream',
      'content-length': String(object.size),
      'content-disposition': `${safeInline ? 'inline' : 'attachment'}; ${contentDispositionFilename(filename)}`,
      'content-security-policy': "sandbox; default-src 'none'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  })
}
