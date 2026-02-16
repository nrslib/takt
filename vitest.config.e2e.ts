import { defineConfig } from 'vitest/config';
import { e2eBaseTestConfig } from './vitest.config.e2e.base';

export default defineConfig({
  test: {
    ...e2eBaseTestConfig,
    include: ['e2e/specs/**/*.e2e.ts'],
  },
});
