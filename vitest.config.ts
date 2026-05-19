import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['../../tests/eds-mcp-server/**/*.test.ts'],
    globals: true,
  },
});
