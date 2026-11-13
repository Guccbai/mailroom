// Test-only D1 and R2 stand-ins backed by node:sqlite and a Map. They apply
// the real migrations so SQL in handlers runs against the real schema.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
)

function normalize(values) {
  return values.map((value) => {
    if (value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    return value
  })
}

function plain(row) {
  return row ? { ...row } : null
}

export function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

/** D1 applies each migration file atomically; mirror that here. */
export function applyMigration(sqlite, file) {
  sqlite.exec('BEGIN')
  try {
    sqlite.exec(readFileSync(join(migrationsDir, file), 'utf8'))
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}

export function createTestDb({ migrations = migrationFiles() } = {}) {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of migrations) applyMigration(sqlite, file)
  const statement = (sql, values = []) => ({
    sql,
    values,
    bind(...next) {
      return statement(sql, normalize(next))
    },
    async first(column) {
      const row = plain(sqlite.prepare(sql).get(...values))
      return column && row ? row[column] : row
    },
    async all() {
      return {
        success: true,
        results: sqlite
          .prepare(sql)
          .all(...values)
          .map(plain),
        meta: {},
      }
    },
    async run() {
      const result = sqlite.prepare(sql).run(...values)
      return {
        success: true,
        results: [],
        meta: { changes: Number(result.changes) },
      }
    },
    execute() {
      const prepared = sqlite.prepare(sql)
      if (/^\s*(select|with)/i.test(sql)) {
        return {
          success: true,
          results: prepared.all(...values).map(plain),
          meta: {},
        }
      }
      const result = prepared.run(...values)
      return {
        success: true,
        results: [],
        meta: { changes: Number(result.changes) },
      }
    },
  })
  return {
    sqlite,
    prepare(sql) {
      return statement(sql)
    },
    async batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((item) => item.execute())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    async exec(sql) {
      sqlite.exec(sql)
      return { count: 1, duration: 0 }
    },
  }
}

async function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value && typeof value.getReader === 'function') {
    return new Uint8Array(await new Response(value).arrayBuffer())
  }
  throw new Error('Unsupported R2 value in test bucket.')
}

export function createTestBucket() {
  const objects = new Map()
  return {
    objects,
    async put(key, value, options = {}) {
      const bytes = await toBytes(value)
      objects.set(key, { bytes, options })
      return { key, size: bytes.byteLength }
    },
    async get(key) {
      const stored = objects.get(key)
      if (!stored) return null
      return {
        key,
        size: stored.bytes.byteLength,
        httpMetadata: stored.options.httpMetadata ?? {},
        customMetadata: stored.options.customMetadata ?? {},
        get body() {
          return new Response(stored.bytes).body
        },
        async arrayBuffer() {
          return stored.bytes.slice().buffer
        },
        async text() {
          return new TextDecoder().decode(stored.bytes)
        },
      }
    },
    async delete(key) {
      for (const item of Array.isArray(key) ? key : [key]) objects.delete(item)
    },
    async list({ prefix = '' } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }
    },
  }
}

export function createTestKv() {
  const values = new Map()
  return {
    values,
    async get(key, type) {
      const entry = values.get(key)
      if (!entry || (entry.expires && entry.expires < Date.now())) return null
      const options = typeof type === 'string' ? { type } : (type ?? {})
      return options.type === 'json' ? JSON.parse(entry.value) : entry.value
    },
    async put(key, value, options = {}) {
      values.set(key, {
        value: typeof value === 'string' ? value : JSON.stringify(value),
        expires: options.expirationTtl
          ? Date.now() + options.expirationTtl * 1000
          : undefined,
        metadata: options.metadata,
      })
    },
    async delete(key) {
      values.delete(key)
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...values.keys()]
        .filter((key) => key.startsWith(prefix))
        .slice(0, limit)
        .map((name) => ({ name, metadata: values.get(name)?.metadata }))
      return { keys, list_complete: true, cursor: '' }
    },
  }
}

export const TEST_API_TOKEN = 'test-api-token-0123456789abcdef'
export const TEST_WEB_PASSWORD = 'correct horse battery staple'

/** A configured mailbox: example.com with hello@ and one inbound message. */
export async function createTestEnv(overrides = {}) {
  const DB = createTestDb()
  const RAW = createTestBucket()
  const now = '2026-11-01T10:00:00.000Z'
  DB.sqlite.exec(`
    INSERT INTO domains (id, domain, from_address, reply_to, relay_url, enabled, created_at, updated_at)
      VALUES ('dom_1', 'example.com', NULL, NULL, NULL, 1, '${now}', '${now}');
    INSERT INTO inboxes (id, domain_id, local_part, name, enabled, created_at, updated_at)
      VALUES ('inb_1', 'dom_1', 'hello', 'Hello', 1, '${now}', '${now}');
    INSERT INTO routes (id, inbox_id, domain_id, kind, local_part, enabled, priority, created_at, updated_at)
      VALUES ('rte_1', 'inb_1', 'dom_1', 'exact', 'hello', 1, 100, '${now}', '${now}');
    INSERT INTO threads (id, inbox_id, normalized_subject, latest_at, message_count, created_at, updated_at)
      VALUES ('thr_1', 'inb_1', 'question', '${now}', 1, '${now}', '${now}');
    INSERT INTO messages (id, thread_id, inbox_id, direction, status, rfc_message_id, in_reply_to,
      message_references, sender, recipients, cc, subject, normalized_subject, preview, text_body,
      html_body, headers, raw_key, size_bytes, attachment_count, received_at, created_at)
      VALUES ('msg_1', 'thr_1', 'inb_1', 'inbound', 'unread', '<q1@example.net>', NULL, '[]',
      'reader@example.net', '["hello@example.com"]', '[]', 'Question', 'question', 'Hi there',
      'Hi there', '<p>Hi <b>there</b></p>', '{}', 'raw/example.com/msg_1.eml', 120, 1, '${now}', '${now}');
    INSERT INTO attachments (id, message_id, filename, content_type, content_id, disposition, size_bytes, r2_key, created_at)
      VALUES ('att_1', 'msg_1', 'notes.txt', 'text/plain', NULL, 'attachment', 5, 'attachments/msg_1/001-att_1', '${now}');
  `)
  await RAW.put('attachments/msg_1/001-att_1', 'hello', {
    httpMetadata: { contentType: 'text/plain' },
  })
  const sent = []
  return {
    DB,
    RAW,
    OAUTH_KV: createTestKv(),
    EMAIL: {
      async send(message) {
        sent.push(message)
        return { messageId: `<sent-${sent.length}@example.com>` }
      },
    },
    INGEST_QUEUE: { async send() {} },
    sent,
    ENVIRONMENT: 'test',
    AI_MODEL: 'test-model',
    MAX_EMAIL_BYTES: '26214400',
    MAILROOM_SEND_MODE: 'live',
    MAILROOM_API_TOKEN: TEST_API_TOKEN,
    MAILROOM_WEB_PASSWORD: TEST_WEB_PASSWORD,
    INGRESS_SECRET: 'ingress-secret-for-tests',
    ...overrides,
  }
}

export function createExecutionContext() {
  const waits = []
  return {
    waits,
    waitUntil(promise) {
      waits.push(promise)
    },
    passThroughOnException() {},
    props: {},
    async settle() {
      await Promise.all(waits)
    },
  }
}
