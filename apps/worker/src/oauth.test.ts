import { describe, expect, it } from 'vitest'
import { redirectSource } from './oauth.js'

describe('consent form redirect source', () => {
  it('allows the client callback origin', () => {
    expect(redirectSource('https://claude.ai/api/mcp/auth_callback')).toBe(
      'https://claude.ai',
    )
    expect(redirectSource('http://127.0.0.1:33418/callback')).toBe(
      'http://127.0.0.1:33418',
    )
    expect(redirectSource('com.example.app:/callback')).toBe('com.example.app:')
  })

  it('ignores values that are not URLs', () => {
    expect(redirectSource('not a url')).toBeNull()
  })
})
