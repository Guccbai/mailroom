import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { generatedSource } from '../scripts/build-web-assets.mjs'

it('embedded web assets match apps/worker/web (run pnpm web:build)', () => {
  const generated = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../src/web-assets.generated.ts',
    ),
    'utf8',
  )
  expect(generated).toBe(generatedSource())
})
