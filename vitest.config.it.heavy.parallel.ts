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
    // fsync-heavy stores. Keep one worker per runner to avoid synchronous IO
    // contention; CI scales out with isolated job-level shards instead.
    maxWorkers: 1,
    include: heavyParallelItTestGlobs,
    exclude: heavyParallelItTestExcludes,
  },
});
