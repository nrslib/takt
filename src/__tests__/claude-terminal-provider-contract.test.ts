import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlobalConfigSchema } from '../core/models/index.js';
import {
  ProviderBlockSchema,
  ProviderPermissionProfilesSchema,
  ProviderReferenceSchema,
  ProviderTypeSchema,
  StepProviderOptionsSchema,
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
