import { describe, expect, it } from 'vitest';
import { normalizeProviderProfiles } from '../infra/config/configNormalizers.js';

describe('normalizeProviderProfiles', () => {
  it('rejects the removed legacy permission override key', () => {
    expect(() => normalizeProviderProfiles({
      codex: {
        default_permission_mode: 'full',
        movement_permission_overrides: {
          implement: 'edit',
        },
      },
    })).toThrow(/movement_permission_overrides/i);
  });
});
