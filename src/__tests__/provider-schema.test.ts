/**
 * Provider schema acceptance tests.
 *
 * Covers the Claude provider split (claude / claude-sdk), the claude-terminal
 * provider contract, and OpenCode/Cursor acceptance across config and
 * workflow schemas.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
  WorkflowStepRawSchema,
  ParallelSubStepRawSchema,
} from '../core/models/index.js';
import {
  PersonaProviderEntrySchema,
  ProviderBlockSchema,
  ProviderPermissionProfilesSchema,
  ProviderReferenceSchema,
  StepProviderOptionsSchema,
  ProviderTypeSchema,
} from '../core/models/schema-base.js';
import { ProviderRegistry, getProvider } from '../infra/providers/index.js';
import {
  providerSupportsAllowedTools,
  providerSupportsClaudeAllowedTools,
  providerSupportsMaxTurns,
  providerSupportsMcpServers,
  providerSupportsStructuredOutput,
} from '../infra/providers/provider-capabilities.js';
import type { ProviderType } from '../infra/providers/types.js';

const CLAUDE_TERMINAL = 'claude-terminal' as ProviderType;

describe('Claude provider split (Zod)', () => {
  describe('ProviderTypeSchema', () => {
    it('Given claude-sdk string, When parse, Then succeeds', () => {
      expect(ProviderTypeSchema.parse('claude-sdk')).toBe('claude-sdk');
    });

    it('Given claude string, When parse, Then succeeds (headless id)', () => {
      expect(ProviderTypeSchema.parse('claude')).toBe('claude');
    });
  });

  describe('ProviderReferenceSchema', () => {
    it('Given shorthand claude-sdk, When parse, Then succeeds', () => {
      expect(ProviderReferenceSchema.parse('claude-sdk')).toBe('claude-sdk');
    });
  });

  describe('ProviderBlockSchema', () => {
    it('Given claude-sdk block with sandbox, When parse, Then succeeds', () => {
      const parsed = ProviderBlockSchema.parse({
        type: 'claude-sdk',
        sandbox: { allow_unsandboxed_commands: true },
      });

      expect(parsed.type).toBe('claude-sdk');
      expect(parsed.sandbox).toEqual({ allow_unsandboxed_commands: true });
    });

    it('Given headless claude block with sandbox, When parse, Then succeeds', () => {
      const parsed = ProviderBlockSchema.parse({
        type: 'claude',
        sandbox: { excluded_commands: ['rm'] },
      });

      expect(parsed.type).toBe('claude');
      expect(parsed.sandbox).toEqual({ excluded_commands: ['rm'] });
    });

    it('Given headless claude block with network_access, When parse, Then fails', () => {
      expect(() =>
        ProviderBlockSchema.parse({
          type: 'claude',
          network_access: true,
        }),
      ).toThrow(/network_access/i);
    });
  });

  describe('PersonaProviderEntrySchema', () => {
    it('Given empty nested provider_options object, When parse, Then fails', () => {
      expect(() =>
        PersonaProviderEntrySchema.parse({
          provider_options: {
            claude: {
              sandbox: {},
            },
          },
        }),
      ).toThrow(/provider_options/i);
    });

    it('Given nested provider_options leaf, When parse, Then succeeds', () => {
      const parsed = PersonaProviderEntrySchema.parse({
        provider_options: {
          claude: {
            sandbox: {
              excluded_commands: ['rm'],
            },
          },
        },
      });

      expect(parsed.provider_options?.claude?.sandbox).toEqual({
        excluded_commands: ['rm'],
      });
    });
  });

  describe('ProviderPermissionProfilesSchema', () => {
    it('Given profiles for claude and claude-sdk, When parse, Then both keys are accepted', () => {
      const parsed = ProviderPermissionProfilesSchema.parse({
        claude: {
          default_permission_mode: 'readonly',
        },
        'claude-sdk': {
          default_permission_mode: 'edit',
        },
      });

      expect(parsed?.claude?.default_permission_mode).toBe('readonly');
      expect(parsed?.['claude-sdk']?.default_permission_mode).toBe('edit');
    });
  });

  describe('Claude Skill provider option', () => {
    it('Given boolean enabled, When parsing provider_options.claude.skills, Then it preserves the value', () => {
      const parsed = StepProviderOptionsSchema.parse({
        claude: { skills: { enabled: false } },
      });

      expect(parsed?.claude?.skills?.enabled).toBe(false);
    });

    it('Given an empty Skills object, When parsing provider_options.claude.skills, Then it is accepted', () => {
      const parsed = StepProviderOptionsSchema.parse({
        claude: { skills: {} },
      });

      expect(parsed?.claude?.skills).toEqual({});
    });

    it('Given a non-boolean enabled value, When parsing provider_options.claude.skills, Then it rejects the configuration', () => {
      expect(() => StepProviderOptionsSchema.parse({
        claude: { skills: { enabled: 'false' } },
      })).toThrow(/enabled|boolean/i);
    });

    it.each([
      ['unknown key', { enabeld: true }],
      ['array', []],
      ['scalar', 'enabled'],
      ['null', null],
    ])(
      'Given %s Skills shape, When parsing provider_options.claude.skills, Then it rejects the configuration',
      (_caseName, skills) => {
        expect(() => StepProviderOptionsSchema.parse({
          claude: { skills },
        })).toThrow(/skills|unrecognized|object/i);
      },
    );
  });

  describe('GlobalConfigSchema default provider', () => {
    it('Given empty object, When parse with defaults, Then provider is claude (headless)', () => {
      const parsed = GlobalConfigSchema.parse({});

      expect(parsed.provider).toBe('claude');
    });

    it('Given explicit claude-sdk provider, When parse, Then preserved', () => {
      const parsed = GlobalConfigSchema.parse({ provider: 'claude-sdk' });

      expect(parsed.provider).toBe('claude-sdk');
    });
  });
});

describe('provider effort values', () => {
  it.each([
    ['codex', { codex: { reasoning_effort: 'max' } }],
    ['claude', { claude: { effort: 'vendor-level' } }],
    ['copilot', { copilot: { effort: 'vendor-level' } }],
  ])('accepts provider-specific effort strings for %s', (_provider, options) => {
    expect(StepProviderOptionsSchema.parse(options)).toEqual(options);
  });

  it('trims provider-specific effort strings', () => {
    expect(StepProviderOptionsSchema.parse({
      codex: { reasoning_effort: '  custom-level  ' },
      claude: { effort: '  custom-level  ' },
      copilot: { effort: '  custom-level  ' },
    })).toEqual({
      codex: { reasoning_effort: 'custom-level' },
      claude: { effort: 'custom-level' },
      copilot: { effort: 'custom-level' },
    });
  });

  it.each([
    ['codex', '', { codex: { reasoning_effort: '' } }],
    ['codex', 'whitespace-only', { codex: { reasoning_effort: '   ' } }],
    ['claude', '', { claude: { effort: '' } }],
    ['claude', 'whitespace-only', { claude: { effort: '   ' } }],
    ['copilot', '', { copilot: { effort: '' } }],
    ['copilot', 'whitespace-only', { copilot: { effort: '   ' } }],
  ])('rejects %s %s effort values', (_provider, _valueKind, options) => {
    expect(() => StepProviderOptionsSchema.parse(options)).toThrow(/effort/);
  });
});

describe('Codex permission control provider option', () => {
  it('accepts takt and codex values', () => {
    expect(StepProviderOptionsSchema.parse({
      codex: { permission_control: 'takt' },
    })).toEqual({ codex: { permission_control: 'takt' } });
    expect(StepProviderOptionsSchema.parse({
      codex: { permission_control: 'codex' },
    })).toEqual({ codex: { permission_control: 'codex' } });
  });

  it('rejects unknown permission control values', () => {
    expect(() => StepProviderOptionsSchema.parse({
      codex: { permission_control: 'workspace' },
    })).toThrow(/permission_control|Invalid option/i);
  });
});

describe('Claude terminal provider contract', () => {
  beforeEach(() => {
    ProviderRegistry.resetInstance();
  });

  afterEach(() => {
    ProviderRegistry.resetInstance();
  });

  it('Given claude-terminal id, When parsing provider schemas, Then the provider is accepted', () => {
    expect(ProviderTypeSchema.parse('claude-terminal')).toBe('claude-terminal');
    expect(ProviderReferenceSchema.parse('claude-terminal')).toBe('claude-terminal');

    const providerBlock = ProviderBlockSchema.parse({
      type: 'claude-terminal',
      model: 'opus',
    });
    const profiles = ProviderPermissionProfilesSchema.parse({
      'claude-terminal': {
        default_permission_mode: 'edit',
      },
    });
    const globalConfig = GlobalConfigSchema.parse({ provider: 'claude-terminal' });

    expect(providerBlock).toEqual({ type: 'claude-terminal', model: 'opus' });
    expect(profiles?.['claude-terminal']?.default_permission_mode).toBe('edit');
    expect(globalConfig.provider).toBe('claude-terminal');
  });

  it('Given claude-terminal provider block with network_access, When parse, Then it fails fast', () => {
    expect(() =>
      ProviderBlockSchema.parse({
        type: 'claude-terminal',
        network_access: true,
      }),
    ).toThrow(/network_access/i);
  });

  it('Given claude-terminal provider block with sandbox, When parse, Then it fails fast', () => {
    expect(() =>
      ProviderBlockSchema.parse({
        type: 'claude-terminal',
        sandbox: { allow_unsandboxed_commands: true },
      }),
    ).toThrow(/sandbox/i);
  });

  it('Given claude_terminal provider options, When parsing, Then terminal options are accepted in snake_case', () => {
    const parsed = StepProviderOptionsSchema.parse({
      claude_terminal: {
        backend: 'tmux',
        timeout_ms: 900000,
        keep_session: false,
        transcript_poll_interval_ms: 500,
      },
    });

    expect(parsed).toEqual({
      claude_terminal: {
        backend: 'tmux',
        timeout_ms: 900000,
        keep_session: false,
        transcript_poll_interval_ms: 500,
      },
    });
  });

  it('Given unsupported claude_terminal options, When parsing, Then unknown keys are rejected', () => {
    expect(() =>
      StepProviderOptionsSchema.parse({
        claude_terminal: {
          backend: 'tmux',
          screen_capture_only: true,
        },
      }),
    ).toThrow(/claude_terminal|screen_capture_only|unrecognized/i);
  });

  it('Given unsupported terminal backend, When parsing, Then only tmux is accepted', () => {
    expect(() =>
      StepProviderOptionsSchema.parse({
        claude_terminal: {
          backend: 'screen',
        },
      }),
    ).toThrow(/backend|tmux|claude_terminal/i);
  });

  it('Given registry lookup, When getProvider(claude-terminal), Then it resolves a structured-output provider', () => {
    const provider = getProvider(CLAUDE_TERMINAL);

    expect(provider.supportsStructuredOutput).toBe(true);
  });

  it('Given claude-terminal capability lookup, When checking workflow-sensitive capabilities, Then they are enabled', () => {
    expect(providerSupportsStructuredOutput(CLAUDE_TERMINAL)).toBe(true);
    expect(providerSupportsAllowedTools(CLAUDE_TERMINAL)).toBe(true);
    expect(providerSupportsClaudeAllowedTools(CLAUDE_TERMINAL)).toBe(true);
    expect(providerSupportsMcpServers(CLAUDE_TERMINAL)).toBe(true);
    expect(providerSupportsMaxTurns(CLAUDE_TERMINAL)).toBe(false);
  });
});

describe('Schemas accept opencode provider', () => {
  it.each([true, false, 'Y/n', 'y/N'] as const)(
    'should accept assistant.formal_spec=%s in global and project schemas',
    (formalSpec) => {
      const raw = { assistant: { formal_spec: formalSpec } };

      expect(GlobalConfigSchema.parse(raw).assistant).toEqual({ formal_spec: formalSpec });
      expect(ProjectConfigSchema.parse(raw).assistant).toEqual({ formal_spec: formalSpec });
    },
  );

  it.each([
    { mode: true },
    { mode: 'Y/n', comments: false },
    { comments: true },
  ] as const)('should accept structured assistant.formal_spec=%j in global and project schemas', (formalSpec) => {
    const raw = { assistant: { formal_spec: formalSpec } };

    expect(GlobalConfigSchema.parse(raw).assistant).toEqual({ formal_spec: formalSpec });
    expect(ProjectConfigSchema.parse(raw).assistant).toEqual({ formal_spec: formalSpec });
  });

  it.each(['yes', 'Y/N', 1, null])(
    'should reject unsupported assistant.formal_spec value %j',
    (formalSpec) => {
      const raw = { assistant: { formal_spec: formalSpec } };

      expect(() => GlobalConfigSchema.parse(raw)).toThrow(/formal_spec|invalid/i);
      expect(() => ProjectConfigSchema.parse(raw)).toThrow(/formal_spec|invalid/i);
    },
  );

  it('should keep assistant.gherkin outside the formal config schemas', () => {
    const raw = { assistant: { gherkin: true } };

    expect(() => GlobalConfigSchema.parse(raw)).toThrow(/gherkin|unrecognized/i);
    expect(() => ProjectConfigSchema.parse(raw)).toThrow(/gherkin|unrecognized/i);
  });

  it('should reject assistant.init_files in GlobalConfigSchema', () => {
    expect(() => GlobalConfigSchema.parse({
      assistant: { init_files: ['docs/context.md'] },
    })).toThrow(/init_files|unrecognized/i);
  });

  it('should accept opencode in GlobalConfigSchema provider field', () => {
    const result = GlobalConfigSchema.parse({ provider: 'opencode' });
    expect(result.provider).toBe('opencode');
  });

  it('should accept persona_providers in GlobalConfigSchema', () => {
    const result = GlobalConfigSchema.parse({
      persona_providers: { coder: { provider: 'opencode' } },
    });
    expect(result.persona_providers).toEqual({ coder: { provider: 'opencode' } });
  });

  it('should accept opencode_api_key in GlobalConfigSchema', () => {
    const result = GlobalConfigSchema.parse({
      opencode_api_key: 'test-key-123',
    });
    expect(result.opencode_api_key).toBe('test-key-123');
  });

  it('should accept arbitrary non-empty opencode variant in provider_options', () => {
    const result = GlobalConfigSchema.parse({
      provider_options: {
        opencode: {
          variant: 'provider-specific-high',
        },
      },
    });

    expect(result.provider_options?.opencode).toEqual({
      variant: 'provider-specific-high',
    });
  });

  it('should accept opencode allowed_tools in provider_options', () => {
    const result = GlobalConfigSchema.parse({
      provider_options: {
        opencode: {
          allowed_tools: ['read', 'glob', 'grep', 'bash'],
        },
      },
    });

    expect(result.provider_options?.opencode).toEqual({
      allowed_tools: ['read', 'glob', 'grep', 'bash'],
    });
  });

  it('should reject empty opencode variant in provider_options', () => {
    expect(() =>
      GlobalConfigSchema.parse({
        provider_options: {
          opencode: {
            variant: '',
          },
        },
      }),
    ).toThrow();
  });

  it.each([
    { model_profiles: { '': 'minimal' } },
    { model_profiles: { 'opencode/*': 'disabled' } },
    { model_profiles: ['minimal'] },
    { model_profiles: 'minimal' },
  ])('should reject invalid opencode guards model_profiles: %j', (guards) => {
    expect(() => GlobalConfigSchema.parse({
      provider_options: { opencode: { guards } },
    })).toThrow();
  });

  it.each([
    { profile: 'disabled' },
    { event_limit: 0 },
    { event_limit: 1.5 },
    { call_timeout_ms: 59_999 },
    { call_timeout_ms: 86_400_001 },
    { call_timeout_ms: 60_000.5 },
    { call_timeout_ms: 0 },
  ])('should reject invalid opencode guard profile or timeout boundary: %j', (guards) => {
    expect(() => GlobalConfigSchema.parse({
      provider_options: { opencode: { guards } },
    })).toThrow();
  });

  it('should reject unknown opencode guard keys in strict provider option contexts', () => {
    expect(() => GlobalConfigSchema.parse({
      takt_providers: {
        selector: {
          provider_options: {
            opencode: { guards: { disable_mandatory: true } },
          },
        },
      },
    })).toThrow();
  });

  it('should accept cursor_api_key in GlobalConfigSchema', () => {
    const result = GlobalConfigSchema.parse({
      cursor_api_key: 'cursor-key-123',
    });
    expect(result.cursor_api_key).toBe('cursor-key-123');
  });

  it('should accept opencode in ProjectConfigSchema', () => {
    const result = ProjectConfigSchema.parse({ provider: 'opencode' });
    expect(result.provider).toBe('opencode');
  });

  it('should accept cursor in ProjectConfigSchema', () => {
    const result = ProjectConfigSchema.parse({ provider: 'cursor' });
    expect(result.provider).toBe('cursor');
  });

  it.each([
    { label: 'workflow step with opencode', schema: WorkflowStepRawSchema, input: { name: 'test-step', provider: 'opencode' } },
    { label: 'workflow step with cursor', schema: WorkflowStepRawSchema, input: { name: 'test-step', provider: 'cursor' } },
    { label: 'parallel sub-step with opencode', schema: ParallelSubStepRawSchema, input: { name: 'sub-1', provider: 'opencode' } },
    { label: 'parallel sub-step with cursor', schema: ParallelSubStepRawSchema, input: { name: 'sub-1', provider: 'cursor' } },
  ])('should reject provider execution settings in workflow YAML: $label', ({ schema, input }) => {
    expect(() => schema.parse(input)).toThrow(
      /workflow YAML no longer accepts provider execution settings.*runtime\.yaml/i,
    );
  });

  it('should still accept existing providers (claude, codex, opencode, cursor, pi, deepseek-harness, mock)', () => {
    for (const provider of ['claude', 'codex', 'opencode', 'cursor', 'pi', 'deepseek-harness', 'mock']) {
      const result = GlobalConfigSchema.parse({ provider });
      expect(result.provider).toBe(provider);
    }
  });
});
