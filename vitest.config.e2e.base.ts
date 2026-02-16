import { UserConfig } from 'vitest/config';

export const e2eBaseTestConfig: UserConfig['test'] = {
  environment: 'node',
  globals: false,
  testTimeout: 240000,
  hookTimeout: 60000,
  teardownTimeout: 30000,
  forceExit: true,
  pool: 'threads',
  poolOptions: {
    threads: {
      singleThread: true,
    },
  },
};
