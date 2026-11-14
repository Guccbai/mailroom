import {
  createAccessToken,
  listAccessTokens,
  revokeAccessToken,
} from '../access-tokens.js'
import { inputString } from '../operation-input.js'
import {
  describeSettings,
  loadStoredSettings,
  updateStoredSettings,
} from '../settings.js'
import type { OperationContext } from '../types.js'

type Input = Record<string, unknown>

export async function settingsGet(context: OperationContext): Promise<unknown> {
  const stored = await loadStoredSettings(context.env.DB)
  return { items: describeSettings(context.rawEnv ?? context.env, stored) }
}

export async function settingsUpdate(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const values = (input.values ?? {}) as Record<string, string | null>
  await updateStoredSettings(context.env.DB, values)
  const stored = await loadStoredSettings(context.env.DB)
  return {
    updated: Object.keys(values),
    items: describeSettings(context.rawEnv ?? context.env, stored),
  }
}

export async function tokensList(context: OperationContext): Promise<unknown> {
  return { items: await listAccessTokens(context.env.DB) }
}

export async function tokensCreate(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  return createAccessToken(context.env.DB, inputString(input, 'name'))
}

export async function tokensRevoke(
  context: OperationContext,
  input: Input,
): Promise<unknown> {
  const id = inputString(input, 'id')
  await revokeAccessToken(context.env.DB, id)
  return { id, revoked: true }
}
