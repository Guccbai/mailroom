import {
  MailroomError,
  operationIsOwnerOnly,
  parseOperationInput,
} from '@mailroom/core'
import { getAttachment } from './operations/attachments.js'
import {
  listAutomations,
  promptGet,
  promptsList,
  testAutomation,
} from './operations/automation.js'
import {
  approveDraft,
  composeDraft,
  createDraft,
  getDraft,
  listDrafts,
  rejectDraft,
  sendDraft,
} from './operations/drafts.js'
import { forwardDraft } from './operations/forward.js'
import {
  getMessage,
  getThread,
  listMessages,
  searchMessages,
  updateMessage,
} from './operations/messages.js'
import {
  notificationsStatus,
  notificationsTest,
} from './operations/notifications.js'
import {
  settingsGet,
  settingsUpdate,
  tokensCreate,
  tokensList,
  tokensRevoke,
} from './operations/settings.js'
import {
  deleteRoute,
  listDomains,
  listInboxes,
  listRoutes,
  upsertDomain,
  upsertInbox,
  upsertRoute,
} from './operations/setup.js'
import { systemStatus } from './operations/system.js'
import type { OperationContext } from './types.js'

type Handler = (
  context: OperationContext,
  input: Record<string, unknown>,
) => Promise<unknown>

const handlers: Record<string, Handler> = {
  'system.status': systemStatus,
  'domains.list': listDomains,
  'domains.upsert': upsertDomain,
  'inboxes.list': listInboxes,
  'inboxes.upsert': upsertInbox,
  'routes.list': listRoutes,
  'routes.upsert': upsertRoute,
  'routes.delete': deleteRoute,
  'messages.list': listMessages,
  'messages.get': getMessage,
  'messages.thread': getThread,
  'messages.search': searchMessages,
  'messages.update': updateMessage,
  'drafts.list': listDrafts,
  'drafts.get': getDraft,
  'drafts.create': createDraft,
  'drafts.compose': composeDraft,
  'drafts.forward': forwardDraft,
  'drafts.approve': approveDraft,
  'drafts.reject': rejectDraft,
  'drafts.send': sendDraft,
  'attachments.get': getAttachment,
  'notifications.status': notificationsStatus,
  'notifications.test': notificationsTest,
  'settings.get': settingsGet,
  'settings.update': settingsUpdate,
  'tokens.list': tokensList,
  'tokens.create': tokensCreate,
  'tokens.revoke': tokensRevoke,
  'automation.list': (_context) => listAutomations(),
  'automation.test': testAutomation,
  'prompts.list': (_context, input) => promptsList(input),
  'prompts.get': (_context, input) => promptGet(input),
}

export async function executeOperation(
  context: OperationContext,
  id: string,
  rawInput: unknown,
): Promise<unknown> {
  const input = parseOperationInput(id, rawInput)
  if (
    operationIsOwnerOnly(id) &&
    context.actor !== undefined &&
    context.actor !== 'api' &&
    context.actor !== 'web'
  ) {
    throw new MailroomError(
      'FORBIDDEN',
      `${id} can only be run by the owner from the web app or with the API token.`,
    )
  }
  const handler = handlers[id]
  if (!handler) {
    throw new MailroomError(
      'INTERNAL_ERROR',
      `Operation ${id} has no Worker implementation.`,
    )
  }
  return handler(context, input)
}

export function missingOperationHandlers(operationIds: string[]): string[] {
  return operationIds.filter((id) => !handlers[id])
}
