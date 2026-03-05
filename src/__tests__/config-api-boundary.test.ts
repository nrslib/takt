import { describe, expect, it } from 'vitest';

describe('config API boundary', () => {
  it('should not expose migration-era fallback loader from global config module', async () => {
    const globalConfig = await import('../infra/config/global/globalConfig.js');
    expect('loadGlobalMigratedProjectLocalFallback' in globalConfig).toBe(false);
  });

  it('should not expose GlobalConfigManager from config public module', async () => {
    const configApi = await import('../infra/config/index.js');

    expect('loadGlobalConfig' in configApi).toBe(true);
    expect('saveGlobalConfig' in configApi).toBe(true);
    expect('invalidateGlobalConfigCache' in configApi).toBe(true);
    expect('GlobalConfigManager' in configApi).toBe(false);
  });
});
