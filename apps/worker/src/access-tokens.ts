import { MailroomError, sha256Hex } from '@mailroom/core'
import { newId, nowIso } from './database.js'

const TOKEN_PREFIX = 'mrt_'

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return (
    TOKEN_PREFIX +
    btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
  )
}

export function looksLikeAccessToken(token: string): boolean {
  return (
    token.startsWith(TOKEN_PREFIX) && token.length >= 40 && token.length <= 80
  )
}

export async function createAccessToken(
  db: D1Database,
  name: string,
): Promise<{
  id: string
  name: string
  token: string
  prefix: string
  createdAt: string
}> {
  const count = await db
    .prepare('SELECT count(*) AS n FROM access_tokens WHERE revoked_at IS NULL')
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= 20) {
    throw new MailroomError(
      'CONFLICT',
      'Revoke an unused token before creating another.',
    )
  }
  const token = randomToken()
  const id = newId('tok')
  const prefix = token.slice(0, 10)
  const createdAt = nowIso()
  await db
    .prepare(
      `INSERT INTO access_tokens (id, name, prefix, token_hash, created_at)
      VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, name, prefix, await sha256Hex(token), createdAt)
    .run()
  return { id, name, token, prefix, createdAt }
}

export async function listAccessTokens(db: D1Database): Promise<unknown[]> {
  const result = await db
    .prepare(
      `SELECT id, name, prefix, created_at, last_used_at, revoked_at
      FROM access_tokens ORDER BY created_at DESC LIMIT 100`,
    )
    .all<Record<string, unknown>>()
  return result.results.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }))
}

export async function revokeAccessToken(
  db: D1Database,
  id: string,
): Promise<void> {
  const result = await db
    .prepare(
      'UPDATE access_tokens SET revoked_at = coalesce(revoked_at, ?) WHERE id = ?',
    )
    .bind(nowIso(), id)
    .run()
  if (!result.meta.changes) {
    throw new MailroomError('NOT_FOUND', `Token ${id} was not found.`)
  }
}

/** Returns the token id when the token is valid and not revoked. */
export async function verifyAccessToken(
  db: D1Database,
  token: string,
): Promise<string | null> {
  if (!looksLikeAccessToken(token)) return null
  try {
    const row = await db
      .prepare(
        'SELECT id FROM access_tokens WHERE token_hash = ? AND revoked_at IS NULL',
      )
      .bind(await sha256Hex(token))
      .first<{ id: string }>()
    if (!row) return null
    await db
      .prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?')
      .bind(nowIso(), row.id)
      .run()
    return row.id
  } catch {
    return null
  }
}
