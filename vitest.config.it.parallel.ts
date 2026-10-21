import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  lightItTestGlobs,
  parallelSrcRunnerConfig,
} from './vitest.config.shared.js';

export function resolveLightItMaxWorkers(cpuCount: number, isCi: boolean): number {
  // Leave one CPU for synchronous tests and keep CI's fatal RPC checks serial.
  return isCi || cpuCount <= 2 ? 1 : 2;
}

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...parallelSrcRunnerConfig,
    maxWorkers: resolveLightItMaxWorkers(availableParallelism(), Boolean(process.env.CI)),
    include: lightItTestGlobs,
  },
});
