import { describe, expect, it } from 'vitest';
import { normalizeProviderBlockOptions } from '../infra/config/providerBlockOptions.js';

describe('normalizeProviderBlockOptions (Claude split)', () => {
  it('Given claude-sdk block with sandbox, When normalize, Then emits claude-shaped step options', () => {
    const result = normalizeProviderBlockOptions({
      type: 'claude-sdk',
      sandbox: {
        allow_unsandboxed_commands: true,
        excluded_commands: ['rm'],
      },
    });

    expect(result).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['rm'],
        },
      },
    });
  });

  it('Given headless claude block with sandbox, When normalize, Then emits claude-shaped step options', () => {
    const result = normalizeProviderBlockOptions({
      type: 'claude',
      sandbox: { allow_unsandboxed_commands: true },
    });

    expect(result).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
        },
      },
    });
  });
});
