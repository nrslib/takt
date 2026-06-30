import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  itTestGlobs,
  serialSrcRunnerConfig,
  srcTestInclude,
} from './vitest.config.shared';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...serialSrcRunnerConfig,
    include: srcTestInclude,
    exclude: itTestGlobs,
  },
});
