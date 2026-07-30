import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The ClickHouse+Postgres integration test polls a batch writer; give it room.
    testTimeout: 30_000,
  },
});
