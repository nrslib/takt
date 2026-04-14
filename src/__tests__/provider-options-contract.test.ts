import { describe, expect, it } from 'vitest';
import {
  PROVIDER_OPTIONS_ENV_SPECS,
  PROVIDER_OPTIONS_TRACE_PATHS,
  getPresentProviderOptionPaths,
  toProviderOptionsTracePath,
} from '../infra/config/providerOptionsContract.js';

describe('providerOptionsContract', () => {
  it('provider_options contract paths stay aligned across env and trace definitions', () => {
    const envPaths = new Set(PROVIDER_OPTIONS_ENV_SPECS.map((spec) => spec.path));

    expect(envPaths).toEqual(new Set([
      'provider_options',
      'provider_options.codex.network_access',
      'provider_options.codex.reasoning_effort',
      'provider_options.opencode.network_access',
      'provider_options.claude.effort',
      'provider_options.claude.sandbox.allow_unsandboxed_commands',
      'provider_options.claude.sandbox.excluded_commands',
      'provider_options.copilot.effort',
    ]));
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude.allowed_tools');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.codex.reasoning_effort');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.copilot.effort');
  });

  it('maps internal provider option paths to traced-config paths', () => {
    expect(toProviderOptionsTracePath('claude.sandbox.allowUnsandboxedCommands'))
      .toBe('provider_options.claude.sandbox.allow_unsandboxed_commands');
    expect(toProviderOptionsTracePath('claude.allowedTools'))
      .toBe('provider_options.claude.allowed_tools');
    expect(toProviderOptionsTracePath('codex.reasoningEffort'))
      .toBe('provider_options.codex.reasoning_effort');
  });

  it('enumerates only present provider option leaves', () => {
    expect(getPresentProviderOptionPaths({
      codex: { networkAccess: true, reasoningEffort: 'high' },
      claude: { effort: 'medium', sandbox: { excludedCommands: ['rm -rf'] } },
      copilot: { effort: 'high' },
    })).toEqual([
      'codex.networkAccess',
      'codex.reasoningEffort',
      'claude.effort',
      'claude.sandbox.excludedCommands',
      'copilot.effort',
    ]);
  });
});
