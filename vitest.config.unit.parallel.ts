import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  itTestGlobs,
  parallelSrcRunnerConfig,
  srcTestInclude,
} from './vitest.config.shared';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...parallelSrcRunnerConfig,
    include: srcTestInclude,
    exclude: itTestGlobs,
  },
});
