import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vitest 4 transforms .tsx with oxc, whose automatic JSX runtime matches
  // what Next's compiler does for the app itself: no extra config needed.
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
