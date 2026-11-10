import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  heavyParallelItTestExcludes,
  heavyParallelItTestGlobs,
  parallelSrcRunnerConfig,
} from './vitest.config.shared.js';

export function resolveHeavyItMaxWorkers(cpuCount: number, isCi: boolean): number {
  return isCi || cpuCount <= 2 ? 1 : Math.min(4, Math.floor(cpuCount / 2));
}

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...parallelSrcRunnerConfig,
    // CI keeps one worker per runner and scales out with job-level shards.
    // Locally use half the CPUs, capped at four to limit IO contention from
    // Git, child processes, and fsync-heavy stores.
    maxWorkers: resolveHeavyItMaxWorkers(availableParallelism(), Boolean(process.env.CI)),
    include: heavyParallelItTestGlobs,
    exclude: heavyParallelItTestExcludes,
  },
});
