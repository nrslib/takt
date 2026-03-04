import { describe, expect, it, vi } from 'vitest';
import { migrateDeprecatedGlobalConfigKeys } from '../infra/config/global/globalConfigLegacyMigration.js';

describe('migrateDeprecatedGlobalConfigKeys', () => {
  it('should return migrated config without mutating input object', () => {
    const rawConfig: Record<string, unknown> = {
      log_level: 'warn',
      observability: {
        provider_events: true,
      },
    };

    const originalSnapshot = JSON.parse(JSON.stringify(rawConfig)) as Record<string, unknown>;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const migrated = migrateDeprecatedGlobalConfigKeys(rawConfig);
      expect(migrated.migratedLogLevel).toBe('warn');
      expect(migrated.migratedConfig).toEqual({
        logging: {
          level: 'warn',
          provider_events: true,
        },
      });
      expect(rawConfig).toEqual(originalSnapshot);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
