import { afterEach, describe, expect, it, vi } from 'vitest';

describe('resolveConfigValue call-chain contract', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../infra/config/global/globalConfig.js');
    vi.doUnmock('../infra/config/project/projectConfig.js');
  });

  it('should fail fast when migrated fallback loader is missing and migrated key is resolved', async () => {
    vi.doMock('../infra/config/project/projectConfig.js', () => ({
      loadProjectConfig: () => ({}),
    }));
    vi.doMock('../infra/config/global/globalConfig.js', () => ({
      loadGlobalConfig: () => ({ language: 'en' }),
    }));

    const { resolveConfigValue } = await import('../infra/config/resolveConfigValue.js');

    expect(() => resolveConfigValue('/tmp/takt-project', 'logLevel')).toThrow();
  });
});
