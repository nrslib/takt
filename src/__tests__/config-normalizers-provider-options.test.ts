import { describe, expect, it } from 'vitest';
import {
  buildRawTaktProvidersOrThrow,
  denormalizeProviderOptions,
} from '../infra/config/configNormalizers.js';

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

  it('should persist effort keys in snake_case alongside existing provider options', () => {
    const result = denormalizeProviderOptions({
      codex: {
        networkAccess: true,
        reasoningEffort: 'high',
      },
      claude: {
        allowedTools: ['Read'],
        effort: 'medium',
      },
    });

    expect(result).toEqual({
      codex: {
        network_access: true,
        reasoning_effort: 'high',
      },
      claude: {
        allowed_tools: ['Read'],
        effort: 'medium',
      },
    });
  });
});

describe('buildRawTaktProvidersOrThrow', () => {
  it('should build raw takt_providers when assistant is set', () => {
    const result = buildRawTaktProvidersOrThrow({
      assistant: {
        provider: 'claude',
        model: 'haiku',
      },
    });

    expect(result).toEqual({
      assistant: {
        provider: 'claude',
        model: 'haiku',
      },
    });
  });

  it('should throw when assistant is empty object', () => {
    expect(() =>
      buildRawTaktProvidersOrThrow({
        assistant: {},
      }),
    ).toThrow(/takt_providers\.assistant/);
  });
});
