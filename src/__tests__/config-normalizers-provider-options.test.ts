import { describe, expect, it } from 'vitest';
import {
  buildRawTaktProvidersOrThrow,
  denormalizeProviderOptions,
  normalizeTaktSelectorProvider,
} from '../infra/config/configNormalizers.js';
import { normalizeProviderOptions } from '../infra/config/providerOptions.js';

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
      copilot: { effort: 'high' },
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
      copilot: { effort: 'high' },
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
      copilot: {
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
      copilot: {
        effort: 'medium',
      },
    });
  });

  it('should round-trip provider base_url leaves through normalize and denormalize', () => {
    const rawProviderOptions = {
      codex: {
        base_url: 'http://127.0.0.1:8787/v1',
      },
      claude: {
        base_url: 'http://127.0.0.1:8787',
      },
    };

    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);
    const denormalizedProviderOptions = denormalizeProviderOptions(normalizedProviderOptions);

    expect(normalizedProviderOptions).toEqual({
      codex: {
        baseUrl: 'http://127.0.0.1:8787/v1',
      },
      claude: {
        baseUrl: 'http://127.0.0.1:8787',
      },
    });
    expect(denormalizedProviderOptions).toEqual(rawProviderOptions);
  });

  it('should round-trip Codex Skill inheritance leaves', () => {
    const rawProviderOptions = {
      codex: {
        skills: {
          repo: false,
          user: true,
        },
      },
    };

    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);
    const denormalizedProviderOptions = denormalizeProviderOptions(normalizedProviderOptions);

    expect(normalizedProviderOptions).toEqual({
      codex: {
        skills: {
          repo: false,
          user: true,
        },
      },
    });
    expect(denormalizedProviderOptions).toEqual(rawProviderOptions);
  });

  it('should round-trip Claude Skill enabled through normalize and denormalize', () => {
    const rawProviderOptions = {
      claude: {
        skills: { enabled: false },
      },
    };

    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);
    const denormalizedProviderOptions = denormalizeProviderOptions(normalizedProviderOptions);

    expect(normalizedProviderOptions).toEqual({
      claude: {
        skills: { enabled: false },
      },
    });
    expect(denormalizedProviderOptions).toEqual(rawProviderOptions);
  });

  it('should round-trip copilot effort through normalize and denormalize', () => {
    const rawProviderOptions = {
      copilot: {
        effort: 'high',
      },
    };

    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);
    const denormalizedProviderOptions = denormalizeProviderOptions(normalizedProviderOptions);

    expect(normalizedProviderOptions).toEqual({
      copilot: {
        effort: 'high',
      },
    });
    expect(denormalizedProviderOptions).toEqual(rawProviderOptions);
  });

  it('should round-trip kiro agent through normalize and denormalize', () => {
    const rawProviderOptions = {
      kiro: {
        agent: 'planner-agent',
      },
    };

    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);
    const denormalizedProviderOptions = denormalizeProviderOptions(normalizedProviderOptions);

    expect(normalizedProviderOptions).toEqual({
      kiro: {
        agent: 'planner-agent',
      },
    });
    expect(denormalizedProviderOptions).toEqual(rawProviderOptions);
  });

  it('should persist kiro agent alongside other provider options', () => {
    const result = denormalizeProviderOptions({
      kiro: { agent: 'coder-agent' },
      opencode: { variant: 'high' },
    });

    expect(result).toEqual({
      kiro: { agent: 'coder-agent' },
      opencode: { variant: 'high' },
    });
  });

  it('should round-trip opencode variant through normalize and denormalize', () => {
    const rawProviderOptions = {
      opencode: {
        network_access: true,
        variant: 'high',
      },
    };

    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);
    const denormalizedProviderOptions = denormalizeProviderOptions(normalizedProviderOptions);

    expect(normalizedProviderOptions).toEqual({
      opencode: {
        networkAccess: true,
        variant: 'high',
      },
    });
    expect(denormalizedProviderOptions).toEqual(rawProviderOptions);
  });

  it('should round-trip opencode allowed_tools through normalize and denormalize', () => {
    const rawProviderOptions = {
      opencode: {
        network_access: true,
        variant: 'high',
        allowed_tools: ['read', 'glob', 'grep', 'bash'],
      },
    };

    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);
    const denormalizedProviderOptions = denormalizeProviderOptions(normalizedProviderOptions);

    expect(normalizedProviderOptions).toEqual({
      opencode: {
        networkAccess: true,
        variant: 'high',
        allowedTools: ['read', 'glob', 'grep', 'bash'],
      },
    });
    expect(denormalizedProviderOptions).toEqual(rawProviderOptions);
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
    ).toThrow(/Configuration error: 'takt_providers\.assistant' must include provider or model\./);
  });

  it.each([
    {
      selector: { provider: 'claude' as const, model: 'selector-model' },
      expected: { provider: 'claude', model: 'selector-model' },
    },
    {
      selector: { model: 'selector-model', provider: 'claude' as const },
      expected: { provider: 'claude', model: 'selector-model' },
    },
  ])('should persist normalized selector fields independently of key insertion order', ({ selector, expected }) => {
    expect(buildRawTaktProvidersOrThrow({ selector })).toEqual({ selector: expected });
  });

  it.each([
    ['an empty selector entry', {}],
    ['empty selector provider options', { providerOptions: {} }],
    ['an empty selector provider branch', { providerOptions: { codex: {} } }],
    ['an unknown selector provider branch', { providerOptions: { unknownProvider: { enabled: true } } }],
    ['an unknown selector option mixed with a valid option', {
      providerOptions: { codex: { reasoningEffort: 'medium', unknownOption: true } },
    }],
    ['an unknown nested selector option', {
      providerOptions: { codex: { skills: { repo: true, unknownSkill: true } } },
    }],
    ['an invalid selector enum value', { providerOptions: { codex: { reasoningEffort: 'turbo' } } }],
    ['a blank selector model', { model: '   ' }],
    ['a snake_case selector alias', { provider_options: { codex: { reasoning_effort: 'medium' } } }],
    ['a snake_case nested option alias', { providerOptions: { codex: { reasoning_effort: 'medium' } } }],
  ])('should reject %s before denormalizing selector provider options', (_label, selector) => {
    expect(() => buildRawTaktProvidersOrThrow({
      selector,
    } as never)).toThrow();
  });

  it('should enforce the trimmed non-empty model contract in direct selector normalization', () => {
    expect(() => normalizeTaktSelectorProvider({ model: '   ' })).toThrow(/model must not be empty/);
    expect(normalizeTaktSelectorProvider({ model: ' selector-model ' })).toEqual({
      model: 'selector-model',
    });
  });
});
