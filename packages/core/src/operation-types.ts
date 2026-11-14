import type * as z from 'zod/v4'
import type { MailroomOperationCategory } from './operations.js'

export type OperationSafety = {
  readOnly: boolean
  destructive: boolean
  idempotent: boolean
  requiresApproval: boolean
  /**
   * Only the owner may run it: the web app or the private API token. MCP
   * clients and issued access tokens are refused.
   */
  ownerOnly?: boolean
}

export type OperationSummary = {
  id: string
  category: MailroomOperationCategory
  name: string
  description: string
  safety: OperationSafety
}

export type OperationDefinition = OperationSummary & {
  useWhen: readonly string[]
  avoidWhen: readonly string[]
  outcome: string
  related: readonly string[]
  inputSchema: z.ZodObject
}

export type OperationDescription = Omit<OperationDefinition, 'inputSchema'> & {
  inputSchema: Record<string, unknown>
}
