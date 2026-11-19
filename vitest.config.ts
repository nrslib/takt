import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  serialSrcRunnerConfig,
  srcTestInclude,
  unitTestExcludes,
} from './vitest.config.shared.js';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...serialSrcRunnerConfig,
    include: srcTestInclude,
    exclude: unitTestExcludes,
  },
});
