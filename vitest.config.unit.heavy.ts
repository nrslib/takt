import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  serialSrcRunnerConfig,
  unitHeavyTestGlobs,
} from './vitest.config.shared.js';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...serialSrcRunnerConfig,
    include: unitHeavyTestGlobs,
  },
});
