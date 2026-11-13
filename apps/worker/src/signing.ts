import { sha256Hex } from '@mailroom/core'

const encoder = new TextEncoder()

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[a-f0-9]+$/.test(hex) || hex.length % 2 !== 0) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/**
 * Derive a purpose-specific HMAC key from the Worker's API token so one
 * secret never signs two kinds of value. Extra material, such as a password
 * hash, invalidates every value signed for that purpose when it changes.
 */
export async function derivedKey(
  env: Pick<Env, 'MAILROOM_API_TOKEN'>,
  purpose: string,
  extra = '',
): Promise<CryptoKey> {
  const material = await sha256Hex(
    `mailroom:${purpose}:${extra}:${env.MAILROOM_API_TOKEN}`,
  )
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(material),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function signValue(
  key: CryptoKey,
  value: string,
): Promise<string> {
  return bytesToHex(
    await crypto.subtle.sign('HMAC', key, encoder.encode(value)),
  )
}

export async function verifyValue(
  key: CryptoKey,
  value: string,
  signatureHex: string,
): Promise<boolean> {
  const signature = hexToBytes(signatureHex)
  if (!signature) return false
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(value))
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return bytesToHex(
    await crypto.subtle.sign('HMAC', key, encoder.encode(value)),
  )
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}
