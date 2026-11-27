import { defineConfig } from 'vitest/config';
import { heavyItGuard } from './scripts/vitest-heavy-it-guard.js';
import {
  commonSrcTestConfig,
  itSerialGitTestGlobs,
  serialSrcRunnerConfig,
} from './vitest.config.shared.js';

export default defineConfig({
  plugins: [heavyItGuard],
  test: {
    ...commonSrcTestConfig,
    ...serialSrcRunnerConfig,
    include: itSerialGitTestGlobs,
  },
});
