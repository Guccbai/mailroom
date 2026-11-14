import {
  describeOperation,
  listOperations,
  MAILROOM_OPERATION_CATEGORIES,
  MailroomError,
  type MailroomOperationCategory,
} from '@mailroom/core'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import {
  attachmentResponse,
  findAttachment,
  verifyDownloadSignature,
} from './attachments.js'
import { requestContext, requireApiToken } from './auth.js'
import { receiveGmailSentEmail } from './gmail-sent-ingress.js'
import { handleInboundEmail } from './inbound-handler.js'
import {
  consumeInboundQueue,
  sweepPendingInbound,
} from './inbound-processing.js'
import { authorizePage, authorizeSubmit, MCP_PATH, mcpFetch } from './oauth.js'
import { executeOperation } from './operation-executor.js'
import { receiveRelayEmail } from './relay-ingress.js'
import { failure, success } from './responses.js'
import { effectiveEnv } from './settings.js'
import type { WorkerApp } from './types.js'
import { serveWebAsset, WEB_ASSET_PATHS } from './web-assets.js'
import {
  checkPassword,
  clearedSessionCookie,
  createSessionValue,
  pruneAuthFailures,
  readCookie,
  SESSION_COOKIE,
  sameOriginRequest,
  sessionCookie,
  verifySessionValue,
  webPasswordConfigured,
} from './web-auth.js'

const app = new Hono<WorkerApp>()

/** Attachments with base64 content need more room than other operations. */
const LARGE_BODY_OPERATIONS = new Set(['drafts.create', 'drafts.compose'])
const LARGE_BODY_BYTES = 16 * 1024 * 1024
const DEFAULT_BODY_BYTES = 1024 * 1024

const tooLarge = (
  context: Parameters<Parameters<typeof bodyLimit>[0]['onError'] & {}>[0],
) =>
  context.json(
    {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'The request body is too large.',
      },
    },
    413,
  )

const operationBodyLimit = createMiddleware<WorkerApp>(async (context, next) =>
  bodyLimit({
    maxSize: LARGE_BODY_OPERATIONS.has(context.req.param('id') ?? '')
      ? LARGE_BODY_BYTES
      : DEFAULT_BODY_BYTES,
    onError: tooLarge,
  })(context, next),
)

app.use('*', requestContext)

for (const path of WEB_ASSET_PATHS) {
  app.get(path, (context) =>
    serveWebAsset(path, context.req.header('if-none-match')),
  )
}

app.get('/authorize', (context) =>
  authorizePage(context.req.raw, context.env, defaultHandler),
)
app.post('/authorize', (context) =>
  authorizeSubmit(context.req.raw, context.env, defaultHandler),
)

app.get('/v1/session', async (context) =>
  context.json({
    ok: true,
    data: {
      authenticated: await verifySessionValue(
        context.env,
        readCookie(context.req.header('cookie') ?? null, SESSION_COOKIE),
      ),
      passwordConfigured: webPasswordConfigured(context.env),
    },
  }),
)

app.post(
  '/v1/session',
  bodyLimit({ maxSize: 8 * 1024, onError: tooLarge }),
  async (context) => {
    try {
      if (!sameOriginRequest(context.req.raw)) {
        throw new MailroomError(
          'FORBIDDEN',
          'Cross-origin sign-in is not allowed.',
        )
      }
      const payload = await context.req
        .json<{ password?: unknown }>()
        .catch(() => ({}) as { password?: unknown })
      await checkPassword(
        context.env,
        context.req.raw,
        typeof payload.password === 'string' ? payload.password : '',
      )
      context.header(
        'set-cookie',
        sessionCookie(await createSessionValue(context.env)),
      )
      return success(context, { authenticated: true })
    } catch (error) {
      return failure(context, error)
    }
  },
)

app.delete('/v1/session', (context) => {
  context.header('set-cookie', clearedSessionCookie())
  return context.json({ ok: true, data: { authenticated: false } })
})

app.get(
  '/v1/attachments/:id/download',
  createMiddleware<WorkerApp>(async (context, next) => {
    const id = context.req.param('id') ?? ''
    if (
      await verifyDownloadSignature(
        context.env,
        id,
        context.req.query('expires'),
        context.req.query('signature'),
      )
    ) {
      const attachment = await findAttachment(context.env.DB, id)
      if (!attachment) {
        return failure(
          context,
          new MailroomError('NOT_FOUND', 'Attachment not found.'),
        )
      }
      return attachmentResponse(
        context.env.RAW,
        attachment,
        context.req.query('inline') === '1',
      )
    }
    await next()
  }),
)
app.get('/health', (context) =>
  context.json({
    ok: true,
    service: 'mailroom',
    time: new Date().toISOString(),
  }),
)

app.post('/v1/ingress', async (context) => {
  try {
    const result = await receiveRelayEmail(
      context.req.raw,
      context.env,
      context.executionCtx,
    )
    return success(context, result, result.duplicate ? 200 : 201)
  } catch (error) {
    return failure(context, error)
  }
})

app.post('/v1/ingress/gmail-sent', async (context) => {
  try {
    const result = await receiveGmailSentEmail(
      context.req.raw,
      context.env,
      context.executionCtx,
    )
    return success(context, result, result.duplicate ? 200 : 201)
  } catch (error) {
    return failure(context, error)
  }
})

app.use('/v1/*', requireApiToken)
app.use('/v1/operations/:id', operationBodyLimit)

app.get('/v1/attachments/:id/download', async (context) => {
  try {
    const attachment = await findAttachment(
      context.env.DB,
      context.req.param('id'),
    )
    if (!attachment) {
      throw new MailroomError('NOT_FOUND', 'Attachment not found.')
    }
    return await attachmentResponse(
      context.env.RAW,
      attachment,
      context.req.query('inline') === '1',
    )
  } catch (error) {
    return failure(context, error)
  }
})

app.get('/v1/operations', (context) => {
  try {
    const rawCategory = context.req.query('category')
    if (
      rawCategory &&
      !MAILROOM_OPERATION_CATEGORIES.includes(
        rawCategory as MailroomOperationCategory,
      )
    ) {
      throw new MailroomError(
        'INVALID_INPUT',
        `Unknown operation category: ${rawCategory}.`,
      )
    }
    return success(
      context,
      listOperations(rawCategory as MailroomOperationCategory | undefined),
    )
  } catch (error) {
    return failure(context, error)
  }
})

app.get('/v1/operations/:id', (context) => {
  try {
    return success(context, describeOperation(context.req.param('id')))
  } catch (error) {
    return failure(context, error)
  }
})

app.post('/v1/operations/:id', async (context) => {
  try {
    const payload = await context.req.json<{ params?: unknown }>()
    const data = await executeOperation(
      {
        env: context.env,
        rawEnv: rawEnvs.get(context.env) ?? context.env,
        executionCtx: context.executionCtx,
        requestId: context.get('requestId'),
        actor: context.get('actor'),
      },
      context.req.param('id'),
      payload.params ?? {},
    )
    return success(context, data)
  } catch (error) {
    return failure(context, error)
  }
})

app.notFound((context) =>
  context.json(
    {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Route not found.' },
    },
    404,
  ),
)

app.onError((error, context) => failure(context, error))

const defaultHandler = {
  fetch: (request: Request, env: Env, executionCtx: ExecutionContext) =>
    app.fetch(request, env, executionCtx),
}

function usesOAuthProvider(pathname: string): boolean {
  return (
    pathname === MCP_PATH ||
    pathname.startsWith(`${MCP_PATH}/`) ||
    pathname.startsWith('/oauth/') ||
    pathname.startsWith('/.well-known/oauth-')
  )
}

/** Remembers the plain Worker environment behind each settings overlay. */
const rawEnvs = new WeakMap<Env, Env>()

async function withSettings(env: Env): Promise<Env> {
  const merged = await effectiveEnv(env)
  if (merged !== env) rawEnvs.set(merged, env)
  return merged
}

const STATIC_PATHS = new Set<string>(WEB_ASSET_PATHS)

export default {
  async fetch(
    request: Request,
    env: Env,
    executionCtx: ExecutionContext,
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (STATIC_PATHS.has(pathname) && request.method === 'GET') {
      return app.fetch(request, env, executionCtx)
    }
    const merged = await withSettings(env)
    if (usesOAuthProvider(pathname)) {
      return mcpFetch(request, merged, executionCtx, defaultHandler)
    }
    return app.fetch(request, merged, executionCtx)
  },
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _executionCtx: ExecutionContext,
  ): Promise<void> {
    await handleInboundEmail(message, await withSettings(env))
  },
  async queue(
    batch: MessageBatch<unknown>,
    env: Env,
    executionCtx: ExecutionContext,
  ): Promise<void> {
    await consumeInboundQueue(batch, await withSettings(env), executionCtx)
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    executionCtx: ExecutionContext,
  ): Promise<void> {
    const merged = await withSettings(env)
    executionCtx.waitUntil(
      Promise.all([sweepPendingInbound(merged), pruneAuthFailures(merged.DB)]),
    )
  },
} satisfies ExportedHandler<Env>
