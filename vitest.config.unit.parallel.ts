import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  itTestGlobs,
  parallelSrcRunnerConfig,
} from './vitest.config.shared';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...parallelSrcRunnerConfig,
    exclude: itTestGlobs,
  },
});
