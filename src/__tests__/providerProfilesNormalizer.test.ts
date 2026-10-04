import { describe, expect, it } from 'vitest';
import { normalizeProviderProfiles } from '../infra/config/configNormalizers.js';

describe('normalizeProviderProfiles', () => {
  it('normalizes provider profile overrides with canonical step keys', () => {
    expect(normalizeProviderProfiles({
      codex: {
        default_permission_mode: 'full',
        step_permission_overrides: {
          implement: 'edit',
        },
      },
      pi: {
        default_permission_mode: 'readonly',
        step_permission_overrides: {
          review: 'full',
        },
      },
    })).toEqual({
      codex: {
        defaultPermissionMode: 'full',
        stepPermissionOverrides: {
          implement: 'edit',
        },
      },
      pi: {
        defaultPermissionMode: 'readonly',
        stepPermissionOverrides: {
          review: 'full',
        },
      },
    });
  });
});
