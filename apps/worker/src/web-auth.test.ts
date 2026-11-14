import { describe, expect, it } from 'vitest'
import { createTestDb, TEST_API_TOKEN } from '../test/sqlite-d1.mjs'
import {
  checkPassword,
  createSessionValue,
  readCookie,
  sameOriginRequest,
  sessionCookie,
  verifySessionValue,
} from './web-auth.js'

const env = {
  MAILROOM_API_TOKEN: TEST_API_TOKEN,
  MAILROOM_WEB_PASSWORD: 'correct horse battery staple',
} as Env

describe('web sessions', () => {
  it('round-trips a signed session and rejects tampering', async () => {
    const value = await createSessionValue(env)
    expect(await verifySessionValue(env, value)).toBe(true)
    const flipped = `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`
    expect(await verifySessionValue(env, flipped)).toBe(false)
    expect(await verifySessionValue(env, 'garbage')).toBe(false)
    expect(await verifySessionValue(env, undefined)).toBe(false)
  })

  it('expires sessions and ends them when the password changes', async () => {
    const value = await createSessionValue(env)
    expect(
      await verifySessionValue(
        env,
        value,
        Date.now() + 8 * 24 * 60 * 60 * 1_000,
      ),
    ).toBe(false)
    expect(
      await verifySessionValue(
        { ...env, MAILROOM_WEB_PASSWORD: 'another long password' },
        value,
      ),
    ).toBe(false)
    expect(
      await verifySessionValue({ ...env, MAILROOM_WEB_PASSWORD: '' }, value),
    ).toBe(false)
  })

  it('uses a host-only, HttpOnly, strict cookie', () => {
    const cookie = sessionCookie('value')
    expect(cookie).toMatch(/^__Host-mailroom_session=value;/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(
      readCookie(
        'a=1; __Host-mailroom_session=abc.def; b=2',
        '__Host-mailroom_session',
      ),
    ).toBe('abc.def')
  })
})

describe('same-origin checks', () => {
  const post = (headers: Record<string, string>) =>
    new Request('https://mail.example.com/v1/operations/drafts.send', {
      method: 'POST',
      headers,
    })

  it('allows same-origin writes and blocks other origins', () => {
    expect(
      sameOriginRequest(post({ origin: 'https://mail.example.com' })),
    ).toBe(true)
    expect(
      sameOriginRequest(post({ origin: 'https://evil.example.com' })),
    ).toBe(false)
    expect(sameOriginRequest(post({ 'sec-fetch-site': 'same-origin' }))).toBe(
      true,
    )
    expect(sameOriginRequest(post({}))).toBe(false)
    expect(sameOriginRequest(new Request('https://mail.example.com/'))).toBe(
      true,
    )
  })
})

describe('password checks', () => {
  const request = new Request('https://mail.example.com/v1/session', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '203.0.113.9' },
  })

  it('locks a client out after five wrong passwords', async () => {
    const DB = createTestDb()
    const withDb = { ...env, DB }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(checkPassword(withDb, request, 'wrong')).rejects.toThrow(
        /incorrect/,
      )
    }
    await expect(
      checkPassword(withDb, request, String(env.MAILROOM_WEB_PASSWORD)),
    ).rejects.toThrow(/Too many/)
    const other = new Request(request.url, {
      method: 'POST',
      headers: { 'cf-connecting-ip': '198.51.100.7' },
    })
    await expect(
      checkPassword(withDb, other, String(env.MAILROOM_WEB_PASSWORD)),
    ).resolves.toBeUndefined()
  })

  it('refuses sign-in when no strong password is configured', async () => {
    const DB = createTestDb()
    await expect(
      checkPassword(
        { ...env, MAILROOM_WEB_PASSWORD: 'short', DB },
        request,
        'short',
      ),
    ).rejects.toThrow(/disabled/)
  })
})
