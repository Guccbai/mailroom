import * as z from 'zod/v4'

export const idSchema = z.string().trim().min(1).max(128)
export const emailAddressSchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .overwrite((value) => value.toLowerCase())
export const domainNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/,
  )
  .overwrite((value) => value.toLowerCase())
export const localPartSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/)
  .overwrite((value) => value.toLowerCase())

export const messageStatusSchema = z.enum([
  'unread',
  'read',
  'archived',
  'spam',
])
export type MessageStatus = z.infer<typeof messageStatusSchema>

export const directionSchema = z.enum(['inbound', 'outbound'])
export type MessageDirection = z.infer<typeof directionSchema>

export const draftStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'sending',
  'sent',
  'failed',
])
export type DraftStatus = z.infer<typeof draftStatusSchema>

export const routeKindSchema = z.enum(['exact', 'catchall'])
export type RouteKind = z.infer<typeof routeKindSchema>

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).max(512).optional(),
})

export const messageSummarySchema = z.object({
  id: idSchema,
  threadId: idSchema,
  inboxId: idSchema,
  direction: directionSchema,
  status: messageStatusSchema,
  from: emailAddressSchema,
  to: z.array(emailAddressSchema).max(50),
  subject: z.string().max(998),
  preview: z.string().max(500),
  receivedAt: z.string().datetime(),
  hasAttachments: z.boolean(),
})
export type MessageSummary = z.infer<typeof messageSummarySchema>

export const routeRecordSchema = z.object({
  id: idSchema,
  inboxId: idSchema,
  domain: domainNameSchema,
  kind: routeKindSchema,
  localPart: localPartSchema.nullable(),
  enabled: z.boolean(),
  priority: z.number().int(),
})
export type RouteRecord = z.infer<typeof routeRecordSchema>

export const apiMetaSchema = z.object({
  requestId: z.string(),
  generatedAt: z.string().datetime(),
  nextCursor: z.string().nullable().optional(),
  outputBudget: z
    .object({
      maxBytes: z.number().int(),
      originalBytes: z.number().int(),
      returnedBytes: z.number().int(),
      truncated: z.boolean(),
      omissions: z.array(
        z.object({
          path: z.string(),
          kind: z.enum(['array', 'string', 'field']),
          available: z.number().int().optional(),
          returned: z.number().int().optional(),
        }),
      ),
    })
    .optional(),
})

export const apiSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
  meta: apiMetaSchema,
})
export type ApiSuccess = z.infer<typeof apiSuccessSchema>

export const apiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum([
      'AUTH_REQUIRED',
      'FORBIDDEN',
      'INVALID_INPUT',
      'NOT_FOUND',
      'CONFLICT',
      'RATE_LIMITED',
      'REMOTE_ERROR',
      'INTERNAL_ERROR',
    ]),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})
export type ApiError = z.infer<typeof apiErrorSchema>

export const apiResponseSchema = z.union([apiSuccessSchema, apiErrorSchema])
export type ApiResponse = z.infer<typeof apiResponseSchema>

export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4

export const attachmentFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.charCodeAt(0)
        return (
          character === '/' || character === '\\' || code < 32 || code === 127
        )
      }),
    'Filenames cannot contain slashes or control characters.',
  )

export const contentTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/)

export const base64Schema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ATTACHMENT_BASE64_LENGTH)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Content must be standard base64.')
  .refine((value) => value.length % 4 === 0, 'Base64 length is invalid.')

export const attachmentInputSchema = z.object({
  filename: attachmentFilenameSchema,
  contentType: contentTypeSchema.default('application/octet-stream'),
  contentBase64: base64Schema,
})
export type AttachmentInput = z.infer<typeof attachmentInputSchema>

export const attachmentListSchema = z
  .array(attachmentInputSchema)
  .max(MAX_ATTACHMENTS)

export const recipientListSchema = z.array(emailAddressSchema).max(50)

export const outboundAttachmentSchema = z.object({
  filename: attachmentFilenameSchema,
  contentType: contentTypeSchema,
  contentBase64: base64Schema,
})
export type OutboundAttachment = z.infer<typeof outboundAttachmentSchema>

export const outboundMessageSchema = z.object({
  from: emailAddressSchema,
  to: z.union([emailAddressSchema, z.array(emailAddressSchema).min(1).max(50)]),
  cc: recipientListSchema.optional(),
  replyTo: emailAddressSchema.nullable().optional(),
  subject: z.string().trim().min(1).max(998),
  text: z.string().max(250_000),
  html: z.string().max(500_000).nullable().optional(),
  inReplyTo: z.string().trim().max(998).nullable().optional(),
  references: z.array(z.string().trim().max(998)).max(100).optional(),
  attachments: z
    .array(outboundAttachmentSchema)
    .max(MAX_ATTACHMENTS)
    .optional(),
})
export type OutboundMessage = z.infer<typeof outboundMessageSchema>

/** Decoded byte length of a validated base64 string. */
export function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}
