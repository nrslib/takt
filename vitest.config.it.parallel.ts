import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  itSerialTestGlobs,
  itTestGlobs,
  parallelSrcRunnerConfig,
} from './vitest.config.shared.js';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...parallelSrcRunnerConfig,
    include: itTestGlobs,
    exclude: itSerialTestGlobs,
  },
});
