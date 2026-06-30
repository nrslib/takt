import { defineConfig } from 'vitest/config';
import { e2eBaseTestConfig } from './vitest.config.e2e.base';
import { mockE2eSpecs } from './vitest.config.e2e.mock-specs.mjs';

export default defineConfig({
  test: {
    ...e2eBaseTestConfig,
    include: mockE2eSpecs,
  },
});
