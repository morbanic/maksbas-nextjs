import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // PGlite boots a WASM Postgres per suite; the default 5s is tight on a cold run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
