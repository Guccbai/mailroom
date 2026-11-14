import { MailroomError, sha256Hex, verifyBearerToken } from '@mailroom/core'
import { nowIso } from './database.js'
import { derivedKey, signValue, verifyValue } from './signing.js'

export const SESSION_COOKIE = '__Host-mailroom_session'
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

const FAILURE_WINDOW_MS = 15 * 60 * 1_000
const LOCK_MS = 15 * 60 * 1_000
const PER_CLIENT_LIMIT = 5
const GLOBAL_LIMIT = 50

type AuthEnv = Pick<Env, 'MAILROOM_API_TOKEN' | 'MAILROOM_WEB_PASSWORD'>

export function webPasswordConfigured(env: AuthEnv): boolean {
  return (env.MAILROOM_WEB_PASSWORD?.length ?? 0) >= 12
}

async function sessionKey(env: AuthEnv): Promise<CryptoKey> {
  // Changing the password or API token ends every existing session.
  return derivedKey(
    env,
    'web-session',
    await sha256Hex(env.MAILROOM_WEB_PASSWORD ?? ''),
  )
}

export async function createSessionValue(
  env: AuthEnv,
  now = Date.now(),
): Promise<string> {
  const expires = Math.floor(now / 1000) + SESSION_TTL_SECONDS
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const payload = `${expires}.${nonce}`
  return `${payload}.${await signValue(await sessionKey(env), payload)}`
}

export async function verifySessionValue(
  env: AuthEnv,
  value: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!value || !webPasswordConfigured(env)) return false
  const match = value.match(/^(\d{1,12})\.([a-f0-9]{32})\.([a-f0-9]{64})$/)
  if (!match) return false
  const [, expires, nonce, signature] = match
  if (Number(expires) * 1000 <= now) return false
  return verifyValue(
    await sessionKey(env),
    `${expires}.${nonce}`,
    String(signature),
  )
}

export function readCookie(
  header: string | null,
  name: string,
): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
}

/**
 * Cookie-authenticated writes must come from this origin. SameSite=Strict
 * already blocks cross-site cookies; this check covers same-site subdomains.
 */
export function sameOriginRequest(request: Request): boolean {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  const origin = request.headers.get('origin')
  if (origin) return origin === new URL(request.url).origin
  return request.headers.get('sec-fetch-site') === 'same-origin'
}

export function clientKey(request: Request): string {
  return `ip:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`
}

type FailureRow = {
  failures: number
  window_started_at: string
  locked_until: string | null
}

export async function assertNotLocked(
  db: D1Database,
  keys: string[],
  now = Date.now(),
): Promise<void> {
  const placeholders = keys.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT key, failures, window_started_at, locked_until
      FROM auth_failures WHERE key IN (${placeholders})`,
    )
    .bind(...keys)
    .all<FailureRow & { key: string }>()
  for (const row of rows.results) {
    if (row.locked_until && Date.parse(row.locked_until) > now) {
      throw new MailroomError(
        'RATE_LIMITED',
        'Too many failed sign-in attempts. Try again in 15 minutes.',
      )
    }
  }
}

async function recordFailureFor(
  db: D1Database,
  key: string,
  limit: number,
  now: number,
): Promise<void> {
  const row = await db
    .prepare(
      'SELECT failures, window_started_at, locked_until FROM auth_failures WHERE key = ?',
    )
    .bind(key)
    .first<FailureRow>()
  const windowOpen =
    row && now - Date.parse(row.window_started_at) < FAILURE_WINDOW_MS
  const failures = windowOpen ? row.failures + 1 : 1
  const windowStartedAt = windowOpen
    ? row.window_started_at
    : new Date(now).toISOString()
  const lockedUntil =
    failures >= limit ? new Date(now + LOCK_MS).toISOString() : null
  await db
    .prepare(
      `INSERT INTO auth_failures (key, failures, window_started_at, locked_until)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET failures = excluded.failures,
        window_started_at = excluded.window_started_at,
        locked_until = excluded.locked_until`,
    )
    .bind(key, failures, windowStartedAt, lockedUntil)
    .run()
}

export async function recordFailure(
  db: D1Database,
  client: string,
  now = Date.now(),
): Promise<void> {
  await recordFailureFor(db, client, PER_CLIENT_LIMIT, now)
  await recordFailureFor(db, 'global', GLOBAL_LIMIT, now)
}

export async function clearFailures(
  db: D1Database,
  client: string,
): Promise<void> {
  await db.prepare('DELETE FROM auth_failures WHERE key = ?').bind(client).run()
}

/**
 * Verify the owner's web password with lockout. Shared by the web sign-in
 * and the MCP OAuth consent page.
 */
export async function checkPassword(
  env: AuthEnv & { DB: D1Database },
  request: Request,
  password: string,
): Promise<void> {
  if (!webPasswordConfigured(env)) {
    throw new MailroomError(
      'FORBIDDEN',
      'Web sign-in is disabled. Set MAILROOM_WEB_PASSWORD to at least 12 characters.',
    )
  }
  const client = clientKey(request)
  await assertNotLocked(env.DB, [client, 'global'])
  const valid =
    password.length > 0 &&
    password.length <= 1_024 &&
    (await verifyBearerToken(password, String(env.MAILROOM_WEB_PASSWORD)))
  if (!valid) {
    await recordFailure(env.DB, client)
    throw new MailroomError('AUTH_REQUIRED', 'The password is incorrect.')
  }
  await clearFailures(env.DB, client)
}

export async function pruneAuthFailures(db: D1Database): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()
  await db
    .prepare(
      `DELETE FROM auth_failures WHERE window_started_at < ?
        AND (locked_until IS NULL OR locked_until < ?)`,
    )
    .bind(cutoff, nowIso())
    .run()
}
