import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    fileParallelism: process.env['TALENTLENS_RUN_PG_INTEGRATION'] !== '1',
  },
});
