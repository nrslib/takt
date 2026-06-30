import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  itSerialWorkflowLoaderTestGlobs,
  serialSrcRunnerConfig,
} from './vitest.config.shared.js';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...serialSrcRunnerConfig,
    include: itSerialWorkflowLoaderTestGlobs,
  },
});
