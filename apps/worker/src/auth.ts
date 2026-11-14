import { verifyBearerToken } from '@mailroom/core'
import { createMiddleware } from 'hono/factory'
import type { WorkerApp } from './types.js'
import {
  readCookie,
  SESSION_COOKIE,
  sameOriginRequest,
  verifySessionValue,
} from './web-auth.js'

export const requestContext = createMiddleware<WorkerApp>(
  async (context, next) => {
    const requestId =
      context.req.header('cf-ray') ?? `req_${crypto.randomUUID()}`
    context.set('requestId', requestId)
    context.header('x-request-id', requestId)
    await next()
  },
)

function unauthorized(message: string, code = 'AUTH_REQUIRED', status = 401) {
  return Response.json({ ok: false, error: { code, message } }, { status })
}

/**
 * Accept the private API token, or the owner's web session cookie for
 * same-origin requests from the web app.
 */
export const requireApiToken = createMiddleware<WorkerApp>(
  async (context, next) => {
    const value = context.req.header('authorization')
    if (value?.startsWith('Bearer ')) {
      const token = value.slice(7)
      if (
        !token ||
        !(await verifyBearerToken(token, context.env.MAILROOM_API_TOKEN))
      ) {
        return unauthorized('A valid Mailroom API token is required.')
      }
      context.set('actor', 'api')
      await next()
      return
    }
    const session = readCookie(
      context.req.header('cookie') ?? null,
      SESSION_COOKIE,
    )
    if (await verifySessionValue(context.env, session)) {
      if (!sameOriginRequest(context.req.raw)) {
        return unauthorized(
          'Cross-origin requests are not allowed.',
          'FORBIDDEN',
          403,
        )
      }
      context.set('actor', 'web')
      await next()
      return
    }
    return unauthorized('A valid Mailroom API token is required.')
  },
)
