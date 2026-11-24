import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  parallelSrcRunnerConfig,
  srcTestInclude,
  unitTestExcludes,
} from './vitest.config.shared.js';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...parallelSrcRunnerConfig,
    include: srcTestInclude,
    exclude: unitTestExcludes,
  },
});
