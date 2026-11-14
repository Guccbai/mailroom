import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    clean: true,
    deps: {
      alwaysBundle: [/^@mailroom\//, /^@modelcontextprotocol\/sdk(?:\/|$)/],
      onlyBundle: false,
    },
  },
  {
    // Runtime-neutral tool registration for the Worker's remote MCP endpoint.
    // Dependencies stay external so the Worker bundles one SDK and one Zod.
    entry: { tools: 'src/discovery-tools.ts' },
    format: ['esm'],
    platform: 'neutral',
    target: 'es2022',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: [/^@mailroom\//, /^@modelcontextprotocol\/sdk(?:\/|$)/, /^zod/],
      onlyBundle: false,
    },
  },
])
