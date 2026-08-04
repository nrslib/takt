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
    // exceed the 15s unit default.
    testTimeout: 60_000,
    // fsync and spawnSync serialize at the device/kernel level, so extra
    // workers only add contention: a worker stuck >60s in synchronous IO
    // trips the vitest worker RPC timeout as a spurious unhandled error.
    maxWorkers: 4,
    include: itTestGlobs,
    exclude: itSerialTestGlobs,
  },
});
