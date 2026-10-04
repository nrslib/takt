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
    // Synchronous process and filesystem work can starve a fork worker's
    // onTaskUpdate RPC under parallel load; keep this gate serial so errors
    // remain fatal without depending on local CPU count.
    maxWorkers: 1,
    include: lightItTestGlobs,
  },
});
