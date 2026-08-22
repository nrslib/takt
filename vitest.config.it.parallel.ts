import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  lightItTestGlobs,
  parallelSrcRunnerConfig,
} from './vitest.config.shared.js';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...parallelSrcRunnerConfig,
    include: lightItTestGlobs,
  },
});
