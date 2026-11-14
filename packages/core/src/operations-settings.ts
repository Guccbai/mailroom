import * as z from 'zod/v4'
import type { OperationDefinition } from './operation-types.js'
import { idSchema } from './schemas.js'

/** Owner settings and access tokens, kept apart from mailbox operations. */
export const settingsOperations: readonly OperationDefinition[] = [
  {
    id: 'settings.get',
    category: 'settings',
    name: 'Get settings',
    description: 'Show notification, forwarding, and public URL settings',
    useWhen: ['Checking where a setting comes from'],
    avoidWhen: ['Reading mailbox content'],
    outcome:
      'Returns each setting with its source. Secret values are never returned.',
    related: ['settings.update', 'notifications.status'],
    safety: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      requiresApproval: false,
    },
    inputSchema: z.object({}),
  },
  {
    id: 'settings.update',
    category: 'settings',
    name: 'Update settings',
    description:
      'Change stored settings. null clears a value back to the Worker default',
    useWhen: ['The owner changes notifications, forwarding, or the public URL'],
    avoidWhen: ['Acting for anyone other than the owner'],
    outcome: 'Stores the values and returns the updated settings.',
    related: ['settings.get', 'notifications.test'],
    safety: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      requiresApproval: true,
      ownerOnly: true,
    },
    inputSchema: z.object({
      values: z
        .record(
          z.string().regex(/^[A-Z_]{3,64}$/),
          z.string().max(4_000).nullable(),
        )
        .refine(
          (value) => Object.keys(value).length > 0,
          'Provide at least one value.',
        ),
    }),
  },
  {
    id: 'tokens.list',
    category: 'settings',
    name: 'List access tokens',
    description: 'List issued API and MCP access tokens without their values',
    useWhen: ['Reviewing which clients can connect'],
    avoidWhen: ['Creating a token'],
    outcome: 'Returns names, prefixes, and last-use times.',
    related: ['tokens.create', 'tokens.revoke'],
    safety: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      requiresApproval: false,
      ownerOnly: true,
    },
    inputSchema: z.object({}),
  },
  {
    id: 'tokens.create',
    category: 'settings',
    name: 'Create an access token',
    description: 'Issue a bearer token for an MCP client or script',
    useWhen: ['A client cannot use OAuth'],
    avoidWhen: ['The client supports OAuth'],
    outcome: 'Returns the token once. Only a hash is stored.',
    related: ['tokens.list', 'tokens.revoke'],
    safety: {
      readOnly: false,
      destructive: false,
      idempotent: false,
      requiresApproval: true,
      ownerOnly: true,
    },
    inputSchema: z.object({ name: z.string().trim().min(1).max(80) }),
  },
  {
    id: 'tokens.revoke',
    category: 'settings',
    name: 'Revoke an access token',
    description: 'Stop one issued token from working',
    useWhen: ['A client no longer needs access'],
    avoidWhen: ['Rotating the Worker API token'],
    outcome: 'Marks the token revoked.',
    related: ['tokens.list'],
    safety: {
      readOnly: false,
      destructive: true,
      idempotent: true,
      requiresApproval: true,
      ownerOnly: true,
    },
    inputSchema: z.object({ id: idSchema }),
  },
]
