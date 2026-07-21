import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  itSerialTestGlobs,
  itTestGlobs,
  parallelSrcRunnerConfig,
  srcTestInclude,
} from './vitest.config.shared.js';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...parallelSrcRunnerConfig,
    include: srcTestInclude,
    exclude: [...itTestGlobs, ...itSerialTestGlobs],
  },
});
