import { describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { buildSdkOptions } from '../infra/claude/options-builder.js';
import type { ClaudeSpawnOptions } from '../infra/claude/types.js';

const DENY_RULES = ['Read(./.env)', 'Read(~/.ssh/**)'];

function readInlineSettings(options: Options): Record<string, unknown> | undefined {
  const { settings } = options;
  if (settings === undefined) {
    return undefined;
  }
  return (typeof settings === 'string' ? JSON.parse(settings) : settings) as Record<string, unknown>;
}

function build(overrides: Partial<ClaudeSpawnOptions> = {}): Options {
  return buildSdkOptions({ cwd: '/project', permissionMode: 'edit', ...overrides });
}

describe('SdkOptionsBuilder deny rules (claude-sdk flag settings)', () => {
  it('Given deny rules, When building SDK options, Then the flag settings carry exactly permissions.deny', () => {
    const options = build({ denyRules: DENY_RULES });

    expect(readInlineSettings(options)).toEqual({ permissions: { deny: DENY_RULES } });
  });

  it('Given no deny rules, When building SDK options, Then no flag settings are added', () => {
    const options = build();

    expect(options).not.toHaveProperty('settings');
    expect(options.settingSources).toEqual(['project']);
  });

  it('Given only a sandbox option, When building SDK options, Then no flag settings are added for deny', () => {
    const options = build({ sandbox: { allowUnsandboxedCommands: true, excludedCommands: ['./gradlew'] } });

    expect(options).not.toHaveProperty('settings');
    expect(options.sandbox).toEqual({ allowUnsandboxedCommands: true, excludedCommands: ['./gradlew'] });
  });

  it('Given deny rules and a sandbox option, When building SDK options, Then both reach the SDK', () => {
    const sandbox = { allowUnsandboxedCommands: true, excludedCommands: ['./gradlew'] };

    const options = build({ denyRules: DENY_RULES, sandbox });

    expect(readInlineSettings(options)).toEqual({ permissions: { deny: DENY_RULES } });
    expect(options.sandbox).toEqual(sandbox);
  });

  it('Given deny rules in strict-readonly isolation, When building SDK options, Then the deny rules are kept while ambient settings stay disabled', () => {
    const options = build({
      denyRules: DENY_RULES,
      internalAgentIsolation: 'strict-readonly',
      allowedTools: [],
    });

    expect(readInlineSettings(options)).toEqual({ permissions: { deny: DENY_RULES } });
    expect(options.settingSources).toEqual([]);
    expect(options.tools).toEqual([]);
  });

  it('Given deny rules with a strict tool allowlist, When building SDK options, Then the deny rules are kept next to the forced sandbox', () => {
    const options = build({
      denyRules: DENY_RULES,
      permissionMode: 'readonly',
      strictToolAllowlist: ['Read'],
      sandbox: { allowUnsandboxedCommands: true },
    });

    expect(readInlineSettings(options)).toEqual({ permissions: { deny: DENY_RULES } });
    expect(options.sandbox).toEqual({ enabled: true, allowUnsandboxedCommands: false });
    expect(options.settingSources).toEqual([]);
  });
});
