import { defineConfig } from 'vitest/config';
import {
  commonSrcTestConfig,
  itSerialGitTestGlobs,
  serialSrcRunnerConfig,
} from './vitest.config.shared.js';

export default defineConfig({
  test: {
    ...commonSrcTestConfig,
    ...serialSrcRunnerConfig,
    include: itSerialGitTestGlobs,
  },
});
