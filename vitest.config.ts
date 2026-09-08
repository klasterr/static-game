import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Generation fuzzing is the slow one; give it room.
    testTimeout: 120000,
  },
});
