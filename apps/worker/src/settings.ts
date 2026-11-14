import { MailroomError } from '@mailroom/core'
import * as z from 'zod/v4'
import { nowIso } from './database.js'

const mailboxList = z.string().transform((value, context) => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === 'string')
    ) {
      return JSON.stringify(
        parsed.map((item) => item.trim().toLowerCase()).filter(Boolean),
      )
    }
  } catch {
    // Report below.
  }
  context.addIssue({
    code: 'custom',
    message: 'Use a JSON array of addresses.',
  })
  return z.NEVER
})

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith('https://'), 'Use an https URL.')

const email = z.string().trim().toLowerCase().email().max(320)

const domainMap = z.string().transform((value, context) => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every(
        (item) => typeof item === 'string' && email.safeParse(item).success,
      )
    ) {
      return JSON.stringify(parsed)
    }
  } catch {
    // Report below.
  }
  context.addIssue({
    code: 'custom',
    message: 'Use a JSON object of domain to address.',
  })
  return z.NEVER
})

const events = z.string().transform((value, context) => {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (
    items.length &&
    items.every(
      (item) => item === 'message.received' || item === 'message.sent',
    )
  ) {
    return [...new Set(items)].join(',')
  }
  context.addIssue({
    code: 'custom',
    message: 'Use message.received, message.sent, or both.',
  })
  return z.NEVER
})

/**
 * Settings the owner may store in D1. A stored value overrides the Worker
 * variable or secret of the same name.
 */
export const SETTING_DEFINITIONS = {
  MAILROOM_PUBLIC_URL: { secret: false, schema: httpsUrl },
  MAILROOM_FORWARD_TO: { secret: false, schema: email },
  MAILROOM_FORWARD_TO_BY_DOMAIN: { secret: false, schema: domainMap },
  TELEGRAM_BOT_TOKEN: {
    secret: true,
    schema: z
      .string()
      .trim()
      .regex(
        /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/,
        'This does not look like a Telegram bot token.',
      ),
  },
  TELEGRAM_CHAT_ID: {
    secret: false,
    schema: z
      .string()
      .trim()
      .regex(
        /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/,
        'Use a numeric chat id or @channel.',
      ),
  },
  TELEGRAM_NOTIFY_MAILBOXES: { secret: false, schema: mailboxList },
  WEBHOOK_URL: { secret: false, schema: httpsUrl },
  WEBHOOK_SECRET: { secret: true, schema: z.string().min(16).max(256) },
  WEBHOOK_EVENTS: { secret: false, schema: events },
  WEBHOOK_NOTIFY_MAILBOXES: { secret: false, schema: mailboxList },
} as const satisfies Record<
  string,
  { secret: boolean; schema: z.ZodType<string, string> }
>

export type SettingKey = keyof typeof SETTING_DEFINITIONS
export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[]

export type StoredSettings = Partial<Record<SettingKey, string>>

function isSettingKey(key: string): key is SettingKey {
  return key in SETTING_DEFINITIONS
}

export async function loadStoredSettings(
  db: D1Database,
): Promise<StoredSettings> {
  try {
    const result = await db
      .prepare('SELECT key, value FROM settings')
      .all<{ key: string; value: string }>()
    const settings: StoredSettings = {}
    for (const row of result.results) {
      if (isSettingKey(row.key)) settings[row.key] = row.value
    }
    return settings
  } catch (error) {
    // Before migration 0004 the table does not exist; fall back to Worker values.
    console.warn('mailroom_settings_unavailable', {
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}

/**
 * The Worker environment with stored settings applied on top. Every place
 * that reads a configurable value uses this instead of the raw environment.
 */
export async function effectiveEnv(env: Env): Promise<Env> {
  const stored = await loadStoredSettings(env.DB)
  return Object.keys(stored).length ? ({ ...env, ...stored } as Env) : env
}

function envValue(env: Env, key: SettingKey): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function describeSettings(env: Env, stored: StoredSettings) {
  return SETTING_KEYS.map((key) => {
    const definition = SETTING_DEFINITIONS[key]
    const storedValue = stored[key]
    const fallback = envValue(env, key)
    const source =
      storedValue !== undefined ? 'web' : fallback ? 'worker' : 'unset'
    const value = storedValue ?? fallback ?? null
    return {
      key,
      secret: definition.secret,
      source,
      configured: value !== null,
      ...(definition.secret ? {} : { value }),
    }
  })
}

export async function updateStoredSettings(
  db: D1Database,
  values: Record<string, string | null>,
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  const now = nowIso()
  for (const [key, raw] of Object.entries(values)) {
    if (!isSettingKey(key)) {
      throw new MailroomError('INVALID_INPUT', `${key} cannot be changed here.`)
    }
    if (raw === null || raw.trim() === '') {
      statements.push(
        db.prepare('DELETE FROM settings WHERE key = ?').bind(key),
      )
      continue
    }
    const parsed = SETTING_DEFINITIONS[key].schema.safeParse(raw)
    if (!parsed.success) {
      throw new MailroomError(
        'INVALID_INPUT',
        `${key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`,
      )
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(key, parsed.data, now),
    )
  }
  if (statements.length) await db.batch(statements)
}
