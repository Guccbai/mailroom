import { MailroomError } from '@mailroom/core'
import {
  findAttachment,
  INLINE_CONTENT_MAX_BYTES,
  readAttachmentBase64,
  signedDownloadPath,
} from '../attachments.js'
import { inputBoolean, inputString } from '../operation-input.js'
import type { OperationContext } from '../types.js'

type Input = Record<string, unknown>

export async function getAttachment(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const id = inputString(input, 'id')
  const attachment = await findAttachment(context.env.DB, id)
  if (!attachment) {
    throw new MailroomError('NOT_FOUND', `Attachment ${id} was not found.`)
  }
  const includeContent = inputBoolean(input, 'includeContent')
  const inlineAllowed = attachment.sizeBytes <= INLINE_CONTENT_MAX_BYTES
  return {
    id: attachment.id,
    ...(attachment.kind === 'message'
      ? { messageId: attachment.ownerId }
      : { draftId: attachment.ownerId }),
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    download: await signedDownloadPath(context.env, attachment.id),
    ...(includeContent && inlineAllowed
      ? {
          contentBase64: await readAttachmentBase64(
            context.env.RAW,
            attachment.key,
          ),
        }
      : {}),
    ...(includeContent && !inlineAllowed
      ? {
          contentOmitted: `Files over ${INLINE_CONTENT_MAX_BYTES} bytes are not returned inline. Use the download path.`,
        }
      : {}),
  }
}
