import { describe, expect, it } from 'vitest';
import { resolveEffectiveProviderOptions } from '../infra/config/providerOptions.js';

describe('resolveEffectiveProviderOptions', () => {
  it('env origin keeps config value only for overridden leaf', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'codex.networkAccess' ? 'env' : 'local'),
      {
        codex: { networkAccess: true },
        claude: { allowedTools: ['Read', 'Glob'] },
      },
      {
        codex: { networkAccess: false },
        claude: { allowedTools: ['Read', 'Edit'] },
      },
    );

    expect(result).toEqual({
      codex: { networkAccess: true },
      claude: { allowedTools: ['Read', 'Edit'] },
    });
  });

  it('falls back to movement precedence for local/global sources', () => {
    const result = resolveEffectiveProviderOptions(
      'global',
      undefined,
      { claude: { sandbox: { allowUnsandboxedCommands: true } } },
      { claude: { sandbox: { excludedCommands: ['./gradlew'] } } },
    );

    expect(result).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });
});
