import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./test/cloudflare-workers.mjs', import.meta.url),
      ),
    },
  },
  test: {
    server: {
      deps: {
        // Inline so the cloudflare:workers alias applies inside the package.
        inline: ['@cloudflare/workers-oauth-provider'],
      },
    },
  },
  plugins: [
    {
      name: 'mailroom-text-modules',
      enforce: 'pre',
      load(id) {
        if (!id.endsWith('.md') && !id.endsWith('.yaml')) return undefined
        return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`
      },
    },
  ],
})
