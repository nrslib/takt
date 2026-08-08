import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  itSerialTestGlobs,
  itTestGlobs,
  parallelSrcRunnerConfig,
} from './vitest.config.shared.js';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...parallelSrcRunnerConfig,
    // Integration tests drive real engines, git repositories, and fsync-heavy
    // stores; under a loaded worker pool individual tests can legitimately
    // use the shared 120s test timeout.
    testTimeout: 120_000,
    // fsync and spawnSync serialize at the device/kernel level, so extra
    // workers only add contention: a worker stuck >60s in synchronous IO
    // trips the vitest worker RPC timeout as a spurious unhandled error.
    // On CI runners (4 vCPU, unhandled errors fatal) three consecutive runs
    // failed that way with all tests passing, each time on a different
    // spawn-heavy file — so run the slice single-worker there.
    maxWorkers: process.env.CI ? 1 : 4,
    include: itTestGlobs,
    exclude: itSerialTestGlobs,
  },
});
