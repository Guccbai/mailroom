import { WEB_ASSETS } from './web-assets.generated.js'

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Email HTML renders in a sandboxed srcdoc frame, which inherits this
  // policy. Inline styles are needed for email layout; scripts never run.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob: data: about:",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ')

export function webSecurityHeaders(type: string, etag: string): HeadersInit {
  return {
    'content-type': type,
    etag,
    'cache-control': 'no-cache',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  }
}

export const WEB_ASSET_PATHS = ['/', ...Object.keys(WEB_ASSETS)]

export function serveWebAsset(
  path: string,
  ifNoneMatch?: string | null,
): Response {
  const asset = WEB_ASSETS[path === '/' ? '/index.html' : path]
  if (!asset) return new Response('Not found', { status: 404 })
  const headers = webSecurityHeaders(asset.type, asset.etag)
  if (ifNoneMatch === asset.etag) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(asset.body, { headers })
}
