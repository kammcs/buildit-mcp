import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // The stdio smoke test spawns node processes; keep the load light.
    maxWorkers: 2,
  },
});
