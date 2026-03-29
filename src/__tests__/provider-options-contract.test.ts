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
      'provider_options.opencode.network_access',
      'provider_options.claude.sandbox.allow_unsandboxed_commands',
      'provider_options.claude.sandbox.excluded_commands',
    ]));
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude.allowed_tools');
  });

  it('maps internal provider option paths to traced-config paths', () => {
    expect(toProviderOptionsTracePath('claude.sandbox.allowUnsandboxedCommands'))
      .toBe('provider_options.claude.sandbox.allow_unsandboxed_commands');
    expect(toProviderOptionsTracePath('claude.allowedTools'))
      .toBe('provider_options.claude.allowed_tools');
  });

  it('enumerates only present provider option leaves', () => {
    expect(getPresentProviderOptionPaths({
      codex: { networkAccess: true },
      claude: { sandbox: { excludedCommands: ['rm -rf'] } },
    })).toEqual([
      'codex.networkAccess',
      'claude.sandbox.excludedCommands',
    ]);
  });
});
