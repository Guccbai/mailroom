import type { Context } from 'hono'

/** Who is calling: the owner (api token or web session), an issued token, or an MCP client. */
export type Actor = 'api' | 'web' | 'token' | 'mcp'

export type WorkerVariables = {
  requestId: string
  actor: Actor
}

export type WorkerApp = {
  Bindings: Env
  Variables: WorkerVariables
}

export type WorkerContext = Context<WorkerApp>

export type WaitUntilContext = {
  waitUntil(promise: Promise<unknown>): void
}

export type OperationContext = {
  env: Env
  /** The Worker environment without stored settings applied. */
  rawEnv?: Env
  executionCtx: WaitUntilContext
  requestId: string
  actor?: Actor
}

export type JsonRecord = Record<string, unknown>
