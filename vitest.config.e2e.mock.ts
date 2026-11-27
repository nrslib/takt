import { defineConfig } from 'vitest/config';
import { e2eBaseTestConfig } from './vitest.config.e2e.base';
import { mockE2eSpecs } from './vitest.config.e2e.mock-specs.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installNotificationSilence } = require('./scripts/test-notification-silence.cjs') as typeof import('./scripts/test-notification-silence.cjs');
installNotificationSilence();

export default defineConfig({
  test: {
    ...e2eBaseTestConfig,
    setupFiles: ['scripts/test-notification-silence.cjs'],
    include: mockE2eSpecs,
  },
});
