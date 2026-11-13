export function migrationFiles(): string[]
export function applyMigration(sqlite: unknown, file: string): void
export function createTestDb(options?: {
  migrations?: string[]
}): D1Database & {
  sqlite: {
    exec(sql: string): void
    prepare(sql: string): { all(...values: unknown[]): unknown[] }
  }
}
export function createTestBucket(): R2Bucket & {
  objects: Map<string, { bytes: Uint8Array; options: R2PutOptions }>
}
export function createTestKv(): KVNamespace & { values: Map<string, unknown> }
export const TEST_API_TOKEN: string
export const TEST_WEB_PASSWORD: string
export type TestEnv = Env & {
  DB: ReturnType<typeof createTestDb>
  RAW: ReturnType<typeof createTestBucket>
  sent: EmailMessageBuilder[]
}
export function createTestEnv(
  overrides?: Record<string, unknown>,
): Promise<TestEnv>
export function createExecutionContext(): ExecutionContext & {
  waits: Promise<unknown>[]
  settle(): Promise<void>
}
