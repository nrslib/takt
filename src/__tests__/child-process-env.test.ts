import { describe, expect, it, vi } from 'vitest';
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

  it('strips central variables case-insensitively on Windows only', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const restore = enterCentralExecution();
    try {
      expect(buildChildProcessEnv({
        takt_config_dir: '/private/central',
        TaKt_CeNtRaL_OwNeR_ToKeN: 'secret-token',
        ProviderCanary: 'kept',
      })).toEqual({ ProviderCanary: 'kept' });
    } finally {
      restore();
      platform.mockRestore();
    }
  });

  it('keeps mixed-case lookalikes on case-sensitive platforms', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const restore = enterCentralExecution();
    try {
      expect(buildChildProcessEnv({
        takt_config_dir: '/private/central',
        TaKt_CeNtRaL_OwNeR_ToKeN: 'kept',
      })).toEqual({
        takt_config_dir: '/private/central',
        TaKt_CeNtRaL_OwNeR_ToKeN: 'kept',
      });
    } finally {
      restore();
      platform.mockRestore();
    }
  });
});
