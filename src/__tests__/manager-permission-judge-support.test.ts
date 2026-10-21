import { describe, expect, it } from 'vitest';
import { supportsManagerPermissionJudge } from '../features/manager/permissionJudgeSupport.js';
import { PROVIDER_TYPES, type ProviderType } from '../shared/types/provider.js';

describe('supportsManagerPermissionJudge', () => {
  const expectedSupport = {
    claude: true,
    'claude-sdk': true,
    'claude-headless': false,
    'claude-terminal': false,
    codex: true,
    opencode: false,
    cursor: false,
    copilot: false,
    kiro: false,
    pi: false,
    'deepseek-harness': false,
    mock: false,
  } satisfies Record<ProviderType, boolean>;

  it.each(PROVIDER_TYPES)(
    'should report permission judge support for %s',
    (providerType) => {
      expect(supportsManagerPermissionJudge(providerType)).toBe(expectedSupport[providerType]);
    },
  );
});
