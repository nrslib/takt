import { describe, expect, it } from 'vitest';
import {
  buildRawTaktProvidersOrThrow,
  denormalizeProviderOptions,
  normalizeTaktSelectorProvider,
} from '../infra/config/configNormalizers.js';
import { normalizeProviderOptions } from '../infra/config/providerOptions.js';
import { StepProviderOptionsObjectSchema } from '../core/models/schema-base.js';
import type { StepProviderOptions } from '../core/models/workflow-provider-options.js';

describe('Codex fast mode provider option schema', () => {
  it.each([true, false])('accepts an explicit boolean value: %s', (fastMode) => {
    expect(StepProviderOptionsObjectSchema.parse({ codex: { fast_mode: fastMode } })).toEqual({
      codex: { fast_mode: fastMode },
    });
  });

  it('rejects a non-boolean fast mode value', () => {
    expect(() => StepProviderOptionsObjectSchema.parse({ codex: { fast_mode: 'true' } })).toThrow();
  });
});

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
      pi: {},
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

  it('should round-trip Codex permission control', () => {
    const rawProviderOptions = {
      codex: {
        permission_control: 'codex',
      },
    };

    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);

    expect(normalizedProviderOptions).toEqual({
      codex: {
        permissionControl: 'codex',
      },
    });
    expect(denormalizeProviderOptions(normalizedProviderOptions)).toEqual(rawProviderOptions);
  });

  it.each([true, false])('should normalize and denormalize Codex fast_mode=%s', (fastMode) => {
    const rawProviderOptions = { codex: { fast_mode: fastMode } };
    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);

    expect(normalizedProviderOptions).toEqual({ codex: { fastMode } });
    expect(denormalizeProviderOptions(normalizedProviderOptions)).toEqual(rawProviderOptions);
  });

  it.each([true, false])(
    'should round-trip Codex permission control with network_access=%s',
    (networkAccess) => {
      const rawProviderOptions = {
        codex: {
          permission_control: 'codex' as const,
          network_access: networkAccess,
        },
      };

      const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);

      expect(normalizedProviderOptions).toEqual({
        codex: {
          permissionControl: 'codex',
          networkAccess,
        },
      });
      expect(denormalizeProviderOptions(normalizedProviderOptions)).toEqual(rawProviderOptions);
    },
  );

  it('should round-trip OpenCode guard leaves and model_profiles', () => {
    const rawProviderOptions = {
      opencode: {
        guards: {
          profile: 'minimal' as const,
          model_profiles: { 'opencode/*': 'standard' as const },
          call_timeout_ms: 120_000,
          event_limit: 2048,
          text_byte_limit: 1024,
          reasoning_byte_limit: 4096,
        },
      },
    };

    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);
    expect(normalizedProviderOptions).toEqual({
      opencode: {
        guards: {
          profile: 'minimal',
          modelProfiles: { 'opencode/*': 'standard' },
          callTimeoutMs: 120_000,
          eventLimit: 2048,
          textByteLimit: 1024,
          reasoningByteLimit: 4096,
        },
      },
    });
    expect(denormalizeProviderOptions(normalizedProviderOptions)).toEqual(rawProviderOptions);
  });

  it('should round-trip provider call timeout guards for every provider', () => {
    const rawProviderOptions = {
      codex: { guards: { call_timeout_ms: 120_000 } },
      claude: { guards: { call_timeout_ms: 120_000 } },
      claude_terminal: { guards: { call_timeout_ms: 120_000 } },
      copilot: { guards: { call_timeout_ms: 120_000 } },
      kiro: { guards: { call_timeout_ms: 120_000 } },
      cursor: { guards: { call_timeout_ms: 120_000 } },
      pi: { guards: { call_timeout_ms: 120_000 } },
    };

    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);

    expect(normalizedProviderOptions).toEqual({
      codex: { guards: { callTimeoutMs: 120_000 } },
      claude: { guards: { callTimeoutMs: 120_000 } },
      claudeTerminal: { guards: { callTimeoutMs: 120_000 } },
      copilot: { guards: { callTimeoutMs: 120_000 } },
      kiro: { guards: { callTimeoutMs: 120_000 } },
      cursor: { guards: { callTimeoutMs: 120_000 } },
      pi: { guards: { callTimeoutMs: 120_000 } },
    });
    expect(denormalizeProviderOptions(normalizedProviderOptions)).toEqual(rawProviderOptions);
    expect(buildRawTaktProvidersOrThrow({
      selector: {
        provider: 'codex',
        model: 'selector-model',
        providerOptions: normalizedProviderOptions,
      },
    })).toEqual({
      selector: {
        provider: 'codex',
        model: 'selector-model',
        provider_options: rawProviderOptions,
      },
    });
  });

  it('should omit empty provider guard blocks when denormalizing', () => {
    expect(denormalizeProviderOptions({
      codex: { guards: {} },
      copilot: { guards: {} },
      kiro: { guards: {} },
      cursor: { guards: {} },
    })).toBeUndefined();
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

  it('should round-trip Pi SDK resource options through normalize and denormalize', () => {
    const rawProviderOptions = {
      pi: {
        extensions: ['npm:example-extension'],
        no_extensions: true,
        no_skills: false,
        no_prompt_templates: false,
        no_themes: false,
        no_context_files: false,
      },
    };

    const normalizedProviderOptions = normalizeProviderOptions(rawProviderOptions);
    const denormalizedProviderOptions = denormalizeProviderOptions(normalizedProviderOptions);

    expect(normalizedProviderOptions).toEqual({
      pi: {
        extensions: ['npm:example-extension'],
        noExtensions: true,
        noSkills: false,
        noPromptTemplates: false,
        noThemes: false,
        noContextFiles: false,
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

  it('should preserve DeepSeek Harness selector options through the strict normalized schema', () => {
    const result = buildRawTaktProvidersOrThrow({
      selector: {
        provider: 'deepseek-harness',
        providerOptions: {
          deepseekHarness: {
            pythonPath: '/usr/bin/python3',
            maxTokens: 4096,
          },
        },
      },
    });

    expect(result).toEqual({
      selector: {
        provider: 'deepseek-harness',
        provider_options: {
          deepseek_harness: {
            python_path: '/usr/bin/python3',
            max_tokens: 4096,
          },
        },
      },
    });
  });

  it.each([true, false])('should preserve Codex fastMode=%s through the strict normalized selector schema', (fastMode) => {
    const providerOptions: StepProviderOptions = {
      codex: { fastMode },
    };

    expect(buildRawTaktProvidersOrThrow({
      selector: {
        provider: 'codex',
        providerOptions,
      },
    })).toEqual({
      selector: {
        provider: 'codex',
        provider_options: { codex: { fast_mode: fastMode } },
      },
    });
  });

  it('should throw when assistant is empty object', () => {
    expect(() =>
      buildRawTaktProvidersOrThrow({
        assistant: {} as never,
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
    ['an invalid selector effort type', { providerOptions: { codex: { reasoningEffort: 42 } } }],
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
