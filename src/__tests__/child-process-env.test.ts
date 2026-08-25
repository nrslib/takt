import { describe, expect, it } from 'vitest';
import {
  buildChildProcessEnv,
  enterCentralExecution,
} from '../shared/utils/child-process-env.js';
import { interpolateMcpEnv } from '../infra/config/runtime-provider/mcp-schema.js';

describe('central child process environment boundary', () => {
  it('strips the central config and ownership namespace from nested children', () => {
    const restore = enterCentralExecution();
    try {
      const env = buildChildProcessEnv({
        PATH: '/bin',
        TAKT_CONFIG_DIR: '/private/central',
        TAKT_CENTRAL_OWNER_TOKEN: 'secret-token',
        TAKT_CENTRAL_STATE_ID: 'state',
        PROVIDER_CANARY: 'kept',
      });
      expect(env).toEqual({ PATH: '/bin', PROVIDER_CANARY: 'kept' });
    } finally {
      restore();
    }
  });

  it('does not resolve central ownership variables into an MCP child environment', () => {
    const previous = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = '/private/central';
    const restore = enterCentralExecution();
    try {
      expect(() => interpolateMcpEnv({
        type: 'stdio',
        command: 'mcp-server',
        env: { ROOT: '${TAKT_CONFIG_DIR}' },
      })).toThrow(/undefined environment variable/);
    } finally {
      restore();
      if (previous === undefined) delete process.env.TAKT_CONFIG_DIR;
      else process.env.TAKT_CONFIG_DIR = previous;
    }
  });
});
