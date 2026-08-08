import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  heavyParallelItTestExcludes,
  heavyParallelItTestGlobs,
  parallelSrcRunnerConfig,
} from './vitest.config.shared.js';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...parallelSrcRunnerConfig,
    // Heavy ITs drive real engines, Git repositories, child processes, and
    // fsync-heavy stores. On CI, extra workers create enough synchronous IO
    // contention to starve Vitest's worker RPC, so keep one worker there.
    maxWorkers: process.env.CI ? 1 : 4,
    include: heavyParallelItTestGlobs,
    exclude: heavyParallelItTestExcludes,
  },
});
