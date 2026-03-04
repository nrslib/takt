import { describe, expect, it } from 'vitest';
import { denormalizeProviderOptions } from '../infra/config/configNormalizers.js';

describe('denormalizeProviderOptions', () => {
  it('should convert camelCase provider options into persisted snake_case format', () => {
    const result = denormalizeProviderOptions({
      codex: { networkAccess: true },
      opencode: { networkAccess: false },
      claude: {
        allowedTools: ['Read', 'Edit'],
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['npm test'],
        },
      },
    });

    expect(result).toEqual({
      codex: { network_access: true },
      opencode: { network_access: false },
      claude: {
        allowed_tools: ['Read', 'Edit'],
        sandbox: {
          allow_unsandboxed_commands: true,
          excluded_commands: ['npm test'],
        },
      },
    });
  });

  it('should return undefined when provider options do not contain persisted fields', () => {
    const result = denormalizeProviderOptions({
      claude: { sandbox: {} },
    });

    expect(result).toBeUndefined();
  });

  it('should persist claude allowedTools even when sandbox is omitted', () => {
    const result = denormalizeProviderOptions({
      claude: { allowedTools: ['Read', 'Bash'] },
    });

    expect(result).toEqual({
      claude: { allowed_tools: ['Read', 'Bash'] },
    });
  });
});
